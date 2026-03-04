# 📢 MANUAL CHARACTER PUBLISHING SYSTEM

**Feature:** Creator + Admin controlled character publishing with real-time notifications

**Flow:**
1. Create character → Private draft (only creator + admin see it)
2. Creator perfects it → Tests privately
3. Creator clicks "Publish" OR Admin approves
4. Real-time broadcast → Everyone gets notified
5. Character appears in all users' lists

---

## 🏗️ SYSTEM ARCHITECTURE

### **Character States:**

```
DRAFT (0)      → Private to creator + admin
PENDING (1)    → Awaiting admin approval (optional)
PUBLISHED (2)  → Public to everyone
ARCHIVED (3)   → Hidden but not deleted
```

---

## 📦 PART 1: DATABASE SCHEMA

### **Add to Character Metadata:**

```javascript
// In character JSON or database
{
    "name": "Elara the Wizard",
    "description": "...",
    "creator": "alice",
    "created_at": 1707825600000,
    
    // NEW FIELDS:
    "status": "draft",           // "draft" | "pending" | "published" | "archived"
    "published_at": null,         // Timestamp when published
    "published_by": null,         // Who published it (creator or admin)
    "require_approval": false,    // Does admin need to approve?
    
    // Existing:
    "data": {
        "character_book": "USER-alice-Elara_the_Wizard"
    }
}
```

---

## 📦 PART 2: SERVER ENDPOINTS

### **File: `src/endpoints/characters.js`**

```javascript
import { Server } from 'socket.io';

// Assuming you have io from server-main.js
let io;
export function setSocketIO(socketIO) {
    io = socketIO;
}

/**
 * Create character (always starts as draft)
 */
router.post('/create', jsonParser, async (request, response) => {
    try {
        const { name, description, personality, requireApproval = false } = request.body;
        const creatorHandle = request.user?.handle || 'default-user';
        
        // Create character data
        const characterData = {
            name,
            description,
            personality,
            creator: creatorHandle,
            created_at: Date.now(),
            
            // Start as draft
            status: 'draft',
            published_at: null,
            published_by: null,
            require_approval: requireApproval,
            
            data: {}
        };
        
        // Seed lorebook
        const lorebookName = await createSeededLorebook(
            name, 
            creatorHandle, 
            { description, personality },
            request.user.directories.root
        );
        
        characterData.data.character_book = lorebookName;
        
        // Save character file
        const filename = sanitizeFilename(name);
        const filepath = path.join(
            request.user.directories.characters, 
            `${filename}.json`
        );
        
        await fs.writeFile(filepath, JSON.stringify(characterData, null, 2));
        
        console.log(`[Character] Created draft: ${name} by ${creatorHandle}`);
        
        response.json({ 
            success: true, 
            character: name,
            status: 'draft',
            message: 'Character created as draft. Publish when ready!'
        });
        
    } catch (error) {
        console.error('[Character] Creation error:', error);
        response.status(500).json({ error: error.message });
    }
});

/**
 * Publish character (creator or admin)
 */
router.post('/publish/:name', jsonParser, async (request, response) => {
    try {
        const characterName = request.params.name;
        const userHandle = request.user?.handle;
        const isAdmin = request.user?.admin || false;
        
        // Load character
        const character = await loadCharacter(characterName, request.user.directories);
        
        if (!character) {
            return response.status(404).json({ error: 'Character not found' });
        }
        
        // Permission check
        const isCreator = character.creator === userHandle;
        if (!isCreator && !isAdmin) {
            return response.status(403).json({ 
                error: 'Only the creator or admin can publish this character' 
            });
        }
        
        // Check if approval is required
        if (character.require_approval && !isAdmin && character.status !== 'pending') {
            // Creator is requesting approval
            character.status = 'pending';
            await saveCharacter(characterName, character, request.user.directories);
            
            // Notify admins
            io.emit('approval_requested', {
                character: characterName,
                creator: character.creator,
                timestamp: Date.now()
            });
            
            console.log(`[Character] Approval requested: ${characterName}`);
            
            return response.json({ 
                success: true, 
                status: 'pending',
                message: 'Approval requested. Waiting for admin review.'
            });
        }
        
        // Publish the character
        character.status = 'published';
        character.published_at = Date.now();
        character.published_by = userHandle;
        
        await saveCharacter(characterName, character, request.user.directories);
        
        // Broadcast to all connected users
        const announcement = {
            character: characterName,
            creator: character.creator,
            publisher: userHandle,
            description: character.description,
            avatar: character.avatar || null,
            timestamp: Date.now()
        };
        
        io.emit('character_published', announcement);
        
        console.log(`[Character] Published: ${characterName} by ${userHandle}`);
        
        response.json({ 
            success: true, 
            status: 'published',
            message: 'Character published! All users notified.'
        });
        
    } catch (error) {
        console.error('[Character] Publish error:', error);
        response.status(500).json({ error: error.message });
    }
});

/**
 * Unpublish character (revert to draft)
 */
router.post('/unpublish/:name', jsonParser, async (request, response) => {
    try {
        const characterName = request.params.name;
        const userHandle = request.user?.handle;
        const isAdmin = request.user?.admin || false;
        
        const character = await loadCharacter(characterName, request.user.directories);
        
        if (!character) {
            return response.status(404).json({ error: 'Character not found' });
        }
        
        // Permission check
        const isCreator = character.creator === userHandle;
        if (!isCreator && !isAdmin) {
            return response.status(403).json({ error: 'Permission denied' });
        }
        
        // Unpublish
        character.status = 'draft';
        character.published_at = null;
        character.published_by = null;
        
        await saveCharacter(characterName, character, request.user.directories);
        
        // Notify users that character is no longer available
        io.emit('character_unpublished', {
            character: characterName,
            timestamp: Date.now()
        });
        
        console.log(`[Character] Unpublished: ${characterName}`);
        
        response.json({ 
            success: true, 
            status: 'draft',
            message: 'Character reverted to draft'
        });
        
    } catch (error) {
        console.error('[Character] Unpublish error:', error);
        response.status(500).json({ error: error.message });
    }
});

/**
 * Get character list (filtered by status and permissions)
 */
router.get('/list', async (request, response) => {
    try {
        const userHandle = request.user?.handle;
        const isAdmin = request.user?.admin || false;
        
        // Load all characters
        const allCharacters = await loadAllCharacters(request.user.directories);
        
        // Filter based on permissions
        const visibleCharacters = allCharacters.filter(char => {
            // Published: everyone can see
            if (char.status === 'published') return true;
            
            // Draft/Pending: only creator + admin
            if (isAdmin) return true;
            if (char.creator === userHandle) return true;
            
            return false;
        });
        
        response.json({ 
            characters: visibleCharacters,
            total: visibleCharacters.length
        });
        
    } catch (error) {
        console.error('[Character] List error:', error);
        response.status(500).json({ error: error.message });
    }
});

// Helper functions
async function loadCharacter(name, directories) {
    const filename = sanitizeFilename(name);
    const filepath = path.join(directories.characters, `${filename}.json`);
    const data = await fs.readFile(filepath, 'utf8');
    return JSON.parse(data);
}

async function saveCharacter(name, data, directories) {
    const filename = sanitizeFilename(name);
    const filepath = path.join(directories.characters, `${filename}.json`);
    await fs.writeFile(filepath, JSON.stringify(data, null, 2));
}

async function loadAllCharacters(directories) {
    const files = await fs.readdir(directories.characters);
    const characters = [];
    
    for (const file of files) {
        if (file.endsWith('.json')) {
            const filepath = path.join(directories.characters, file);
            const data = await fs.readFile(filepath, 'utf8');
            characters.push(JSON.parse(data));
        }
    }
    
    return characters;
}

function sanitizeFilename(name) {
    return name.replace(/[^a-zA-Z0-9-_]/g, '_').substring(0, 100);
}
```

---

## 📦 PART 3: CLIENT-SIDE UI

### **File: `public/scripts/characters.js`**

```javascript
import io from 'socket.io-client';

// Connect to socket
const socket = io({
    auth: {
        handle: getCurrentUserHandle()
    }
});

// Listen for character published
socket.on('character_published', (data) => {
    console.log('[Socket] Character published:', data);
    
    // Show dramatic notification
    showCharacterPublishedNotification(data);
    
    // Refresh character list
    refreshCharacterList();
    
    // Play sound effect (optional)
    playNotificationSound();
});

// Listen for character unpublished
socket.on('character_unpublished', (data) => {
    console.log('[Socket] Character unpublished:', data.character);
    
    toastr.info(`Character "${data.character}" is no longer available`, 'Character Removed');
    
    // Remove from list if currently viewing
    refreshCharacterList();
});

// Listen for approval requests (admin only)
socket.on('approval_requested', (data) => {
    if (isAdmin()) {
        console.log('[Socket] Approval requested:', data);
        
        showApprovalRequest(data);
    }
});

/**
 * Show dramatic character published notification
 */
function showCharacterPublishedNotification(data) {
    // Create a beautiful notification popup
    const notification = $(`
        <div class="character-published-notification" data-character="${data.character}">
            <div class="notification-header">
                <i class="fa fa-star"></i>
                NEW CHARACTER PUBLISHED!
            </div>
            <div class="notification-body">
                ${data.avatar ? `<img src="${data.avatar}" alt="${data.character}">` : ''}
                <div class="notification-content">
                    <h3>${data.character}</h3>
                    <p class="creator">by ${data.creator}</p>
                    <p class="description">${data.description}</p>
                </div>
            </div>
            <div class="notification-actions">
                <button class="btn-primary open-character">
                    <i class="fa fa-comments"></i> Start Chatting
                </button>
                <button class="btn-secondary dismiss">
                    <i class="fa fa-times"></i> Dismiss
                </button>
            </div>
        </div>
    `);
    
    // Add to page with animation
    $('body').append(notification);
    notification.addClass('show');
    
    // Handle actions
    notification.find('.open-character').on('click', function() {
        selectCharacter(data.character);
        notification.remove();
    });
    
    notification.find('.dismiss').on('click', function() {
        notification.removeClass('show');
        setTimeout(() => notification.remove(), 300);
    });
    
    // Auto-dismiss after 30 seconds
    setTimeout(() => {
        if (notification.is(':visible')) {
            notification.removeClass('show');
            setTimeout(() => notification.remove(), 300);
        }
    }, 30000);
}

/**
 * Show approval request to admins
 */
function showApprovalRequest(data) {
    const notification = $(`
        <div class="approval-request-notification">
            <div class="notification-header">
                <i class="fa fa-gavel"></i>
                APPROVAL REQUESTED
            </div>
            <div class="notification-body">
                <p><strong>${data.creator}</strong> wants to publish:</p>
                <p class="character-name">${data.character}</p>
            </div>
            <div class="notification-actions">
                <button class="btn-success approve" data-character="${data.character}">
                    <i class="fa fa-check"></i> Approve & Publish
                </button>
                <button class="btn-danger reject">
                    <i class="fa fa-times"></i> Reject
                </button>
            </div>
        </div>
    `);
    
    $('body').append(notification);
    notification.addClass('show');
    
    // Handle approval
    notification.find('.approve').on('click', async function() {
        const characterName = $(this).data('character');
        await publishCharacter(characterName);
        notification.remove();
    });
    
    notification.find('.reject').on('click', function() {
        notification.remove();
        toastr.info('Approval request dismissed');
    });
}

/**
 * Publish a character
 */
async function publishCharacter(characterName) {
    try {
        const response = await fetch(`/api/characters/publish/${characterName}`, {
            method: 'POST',
            headers: getRequestHeaders()
        });
        
        const result = await response.json();
        
        if (result.success) {
            toastr.success(result.message, 'Character Published!');
            refreshCharacterList();
        } else {
            toastr.error(result.error || 'Failed to publish', 'Error');
        }
    } catch (error) {
        console.error('[Character] Publish error:', error);
        toastr.error('Failed to publish character', 'Error');
    }
}

/**
 * Add publish button to character editor
 */
function addPublishButton() {
    const characterEditor = $('#character_editor');
    
    // Check if character is draft
    const currentCharacter = getCurrentCharacterData();
    if (!currentCharacter || currentCharacter.status !== 'draft') {
        return;
    }
    
    // Add publish button
    const publishButton = $(`
        <button id="publish_character" class="menu_button" title="Publish character to all users">
            <i class="fa fa-paper-plane"></i>
            <span>Publish Character</span>
        </button>
    `);
    
    characterEditor.find('.character_actions').append(publishButton);
    
    publishButton.on('click', async function() {
        const confirm = await callGenericPopup(
            'Publish this character? All users will be notified and can start chatting!',
            'POPUP_TYPE.CONFIRM'
        );
        
        if (confirm === POPUP_RESULT.AFFIRMATIVE) {
            await publishCharacter(currentCharacter.name);
        }
    });
}
```

---

## 🎨 PART 4: CSS STYLING

### **File: `public/style.css`**

```css
/* Character Published Notification */
.character-published-notification {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%) scale(0.8);
    width: 500px;
    max-width: 90vw;
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    border-radius: 20px;
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
    z-index: 10000;
    opacity: 0;
    transition: all 0.3s ease;
    overflow: hidden;
}

.character-published-notification.show {
    opacity: 1;
    transform: translate(-50%, -50%) scale(1);
}

.character-published-notification .notification-header {
    background: rgba(0, 0, 0, 0.2);
    padding: 15px 20px;
    font-size: 18px;
    font-weight: bold;
    text-align: center;
    color: #fff;
}

.character-published-notification .notification-header i {
    color: #ffd700;
    margin-right: 10px;
    animation: pulse 1s ease-in-out infinite;
}

@keyframes pulse {
    0%, 100% { transform: scale(1); }
    50% { transform: scale(1.2); }
}

.character-published-notification .notification-body {
    padding: 20px;
    display: flex;
    gap: 15px;
    color: #fff;
}

.character-published-notification img {
    width: 120px;
    height: 120px;
    object-fit: cover;
    border-radius: 10px;
    border: 3px solid rgba(255, 255, 255, 0.3);
}

.character-published-notification h3 {
    margin: 0 0 5px 0;
    font-size: 24px;
    color: #fff;
}

.character-published-notification .creator {
    opacity: 0.8;
    font-size: 14px;
    margin: 0 0 10px 0;
}

.character-published-notification .description {
    font-size: 14px;
    line-height: 1.5;
    opacity: 0.9;
}

.character-published-notification .notification-actions {
    padding: 15px 20px;
    display: flex;
    gap: 10px;
    background: rgba(0, 0, 0, 0.2);
}

.character-published-notification button {
    flex: 1;
    padding: 12px;
    border: none;
    border-radius: 8px;
    font-size: 14px;
    font-weight: bold;
    cursor: pointer;
    transition: all 0.2s;
}

.character-published-notification .btn-primary {
    background: #fff;
    color: #667eea;
}

.character-published-notification .btn-primary:hover {
    background: #f0f0f0;
    transform: translateY(-2px);
}

.character-published-notification .btn-secondary {
    background: rgba(255, 255, 255, 0.2);
    color: #fff;
}

.character-published-notification .btn-secondary:hover {
    background: rgba(255, 255, 255, 0.3);
}

/* Approval Request Notification (Admin) */
.approval-request-notification {
    position: fixed;
    top: 20px;
    right: 20px;
    width: 350px;
    background: #ff9800;
    border-radius: 10px;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.3);
    z-index: 10000;
    opacity: 0;
    transform: translateX(400px);
    transition: all 0.3s ease;
}

.approval-request-notification.show {
    opacity: 1;
    transform: translateX(0);
}

.approval-request-notification .notification-header {
    background: rgba(0, 0, 0, 0.2);
    padding: 12px 15px;
    font-weight: bold;
    color: #fff;
}

.approval-request-notification .notification-body {
    padding: 15px;
    color: #fff;
}

.approval-request-notification .character-name {
    font-size: 18px;
    font-weight: bold;
    margin-top: 5px;
}

.approval-request-notification .notification-actions {
    padding: 10px 15px;
    display: flex;
    gap: 10px;
}

.approval-request-notification button {
    flex: 1;
    padding: 10px;
    border: none;
    border-radius: 5px;
    font-weight: bold;
    cursor: pointer;
}

.btn-success {
    background: #4caf50;
    color: #fff;
}

.btn-danger {
    background: #f44336;
    color: #fff;
}
```

---

## 📱 PART 5: UI INTEGRATION

### **Add to Character Creation Form:**

```html
<div class="character-creation-form">
    <!-- Existing fields... -->
    
    <div class="form-section">
        <h3>Publishing Options</h3>
        
        <label>
            <input type="checkbox" id="require_approval" checked>
            Require admin approval before publishing
            <span class="help-text">
                Admin will review before character goes live
            </span>
        </label>
        
        <div class="info-box">
            <i class="fa fa-info-circle"></i>
            <p>Character will be created as a <strong>draft</strong>. Only you and admins can see it until you publish.</p>
        </div>
    </div>
</div>
```

### **Add to Character Card:**

```html
<div class="character-card" data-character="${name}">
    <!-- Existing content... -->
    
    <!-- Status badge -->
    <div class="character-status ${status}">
        ${status === 'draft' ? '📝 Draft' : ''}
        ${status === 'pending' ? '⏳ Pending' : ''}
        ${status === 'published' ? '✅ Published' : ''}
    </div>
    
    <!-- Publish button (if creator or admin) -->
    ${canPublish ? `
        <button class="publish-btn" data-character="${name}">
            <i class="fa fa-paper-plane"></i>
            Publish
        </button>
    ` : ''}
</div>
```

---

## 🎬 COMPLETE USER FLOW

### **Scenario: Alice Publishes "Elara the Wizard"**

```
DAY 1 - 10:00 AM
Alice: Creates character "Elara the Wizard"
├─ Status: DRAFT
├─ ✅ Require admin approval: checked
└─ Visible to: Alice + Admin only

DAY 1 - 2:00 PM
Alice: Edits, tests, perfects Elara
├─ Chats privately
├─ Adds lorebook entries
└─ Gets it perfect

DAY 1 - 4:00 PM
Alice: Clicks "Request Approval"
├─ Status: DRAFT → PENDING
├─ Admin gets notification: "Alice wants to publish Elara"
└─ Waits for approval

DAY 1 - 4:15 PM
Admin: Reviews character
├─ Opens Elara
├─ Checks description, personality
├─ Reviews lorebook
└─ Clicks "Approve & Publish"

DAY 1 - 4:15:01 PM
Server: Broadcasts to all online users

Bob's Browser:
├─ POPUP appears with Elara's info
├─ "NEW CHARACTER PUBLISHED!"
├─ Shows avatar, description
└─ "Start Chatting" button

Charlie's Browser:
├─ Same popup
└─ Can start chatting immediately

DAY 1 - 4:15:05 PM
Everyone: Sees Elara in character list!
```

---

## 📊 COMPARISON TABLE

| Feature | Auto-Push | Manual Publish |
|---------|-----------|----------------|
| Control | ❌ None | ✅ Full control |
| Quality | ⚠️ May be incomplete | ✅ Guaranteed ready |
| Surprise | ❌ Meh | 🎉 Exciting reveal! |
| Admin oversight | ❌ After fact | ✅ Before publish |
| Testing | ⚠️ Public testing | ✅ Private testing |
| Mistakes | 😱 Everyone sees | 😊 Fix before publish |

---

## ✅ BENEFITS

**For Creators:**
- ✅ Test privately before sharing
- ✅ Perfect the character first
- ✅ Control the reveal moment
- ✅ No embarrassing mistakes

**For Admin:**
- ✅ Review before public
- ✅ Quality control
- ✅ Moderate content
- ✅ Approve or reject

**For Users:**
- ✅ Exciting notifications
- ✅ Only see finished characters
- ✅ Better quality
- ✅ Instant access

---

## 🚀 IMPLEMENTATION PRIORITY

1. **Phase 1: Basic Publishing** (Do first)
   - Draft/Published states
   - Publish button
   - WebSocket notifications
   
2. **Phase 2: Admin Approval** (Add later)
   - Pending state
   - Approval workflow
   - Admin notifications

3. **Phase 3: Polish** (When ready)
   - Fancy animations
   - Sound effects
   - Achievement badges ("First to try new character!")

---

Want me to help you implement this? This is WAY better than auto-push! 🎉
