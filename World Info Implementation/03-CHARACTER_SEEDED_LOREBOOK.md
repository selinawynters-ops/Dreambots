# 🌱 CHARACTER-SEEDED LOREBOOK SYSTEM

**Feature:** Automatically create a private lorebook when a character is created

**Visibility:**
- ✅ Character creator can see/edit
- ✅ Admin can see/edit
- ❌ Other users cannot see (but character still uses it)

---

## 📋 FILES TO MODIFY

You need to modify these files:
1. `public/scripts/world-info.js` (already patched)
2. `src/endpoints/characters.js` (add seeding logic)
3. Optional: Add a toggle in character creation UI

---

## 🔧 PART 1: Character Creation Hook

### File: `src/endpoints/characters.js`

Find the character creation endpoint (usually `router.post('/create')`).

Add this function at the top of the file:

```javascript
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs/promises';

/**
 * Creates a seeded lorebook for a new character
 * @param {string} characterName - Name of the character
 * @param {string} creatorHandle - Username of the creator
 * @param {string} dataRoot - Data directory path
 * @returns {Promise<string>} Name of the created lorebook
 */
async function createSeededLorebook(characterName, creatorHandle, dataRoot) {
    // Clean the character name for filename
    const cleanName = characterName
        .replace(/[^a-zA-Z0-9-_]/g, '_')
        .substring(0, 50);
    
    // Generate lorebook name
    const lorebookName = `USER-${creatorHandle}-${cleanName}`;
    
    // Create lorebook structure
    const lorebook = {
        name: lorebookName,
        description: `Private lorebook for ${characterName} (Creator: ${creatorHandle})`,
        entries: {
            // Add a default entry to help the creator get started
            [uuidv4()]: {
                uid: uuidv4(),
                key: [characterName],
                keysecondary: [],
                comment: `Default entry for ${characterName}`,
                content: `[This is ${characterName}'s private lorebook. Add character-specific lore here that only you and admins can edit.]`,
                constant: false,
                selective: true,
                selectiveLogic: 0,
                order: 100,
                position: 0,
                disable: false,
                addMemo: true,
                excludeRecursion: false,
                delayUntilRecursion: false,
                probability: 100,
                useProbability: false,
                depth: 4,
                group: '',
                groupOverride: false,
                groupWeight: 100,
                scanDepth: null,
                caseSensitive: null,
                matchWholeWords: null,
                useGroupScoring: null,
                automationId: '',
                role: 0,
                vectorized: false,
                preventRecursion: false,
                delayUntilRecursionGeneration: false
            }
        }
    };
    
    // Determine the worlds directory path
    const worldsDir = path.join(dataRoot, creatorHandle, 'worlds');
    
    // Ensure directory exists
    await fs.mkdir(worldsDir, { recursive: true });
    
    // Write lorebook file
    const lorebookPath = path.join(worldsDir, `${lorebookName}.json`);
    await fs.writeFile(lorebookPath, JSON.stringify(lorebook, null, 2), 'utf8');
    
    console.log(`[Character Seeding] Created lorebook: ${lorebookName} for character: ${characterName}`);
    
    return lorebookName;
}
```

### Then modify the character creation endpoint:

```javascript
router.post('/create', jsonParser, async (request, response) => {
    try {
        const { name, description, personality, /* other fields */ } = request.body;
        const creatorHandle = request.user?.handle || 'default-user';
        
        // Existing character creation code...
        // (create the character file, etc.)
        
        // NEW: Auto-create seeded lorebook
        try {
            const lorebookName = await createSeededLorebook(
                name, 
                creatorHandle, 
                request.user.directories.root
            );
            
            // Link the lorebook to the character
            // This assumes your character JSON has a "data" field
            characterData.data = characterData.data || {};
            characterData.data.character_book = {
                name: lorebookName,
                description: `Private lore for ${name}`,
                scan_depth: 4,
                token_budget: 1000,
                recursive_scanning: false,
                extensions: {}
            };
            
            console.log(`[Character Seeding] Linked lorebook ${lorebookName} to character ${name}`);
        } catch (seedError) {
            console.error('[Character Seeding] Failed to create seeded lorebook:', seedError);
            // Don't fail character creation if lorebook fails
            // Just log the error and continue
        }
        
        // Rest of character creation code...
        
        response.json({ success: true, characterName: name });
    } catch (error) {
        console.error('Character creation error:', error);
        response.status(500).json({ error: 'Failed to create character' });
    }
});
```

---

## 🔧 PART 2: Optional UI Toggle

### File: `public/index.html` or character creation template

Add a checkbox to the character creation form:

```html
<div class="character-creation-form">
    <!-- Existing fields... -->
    
    <div class="form-group">
        <label>
            <input type="checkbox" id="create_private_lorebook" checked>
            Create private lorebook for this character
            <span class="help-text">
                (Only you and admins can edit. Others can use the character but can't see the lore.)
            </span>
        </label>
    </div>
</div>
```

### File: `public/scripts/script.js` (or wherever character creation is handled)

Modify the character creation function:

```javascript
async function createCharacter() {
    const name = $('#character_name').val();
    const description = $('#character_description').val();
    const createPrivateLorebook = $('#create_private_lorebook').is(':checked');
    
    const characterData = {
        name,
        description,
        // other fields...
        seedLorebook: createPrivateLorebook  // Send to server
    };
    
    const response = await fetch('/api/characters/create', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify(characterData)
    });
    
    // Handle response...
}
```

### Update server endpoint to respect the toggle:

```javascript
router.post('/create', jsonParser, async (request, response) => {
    const { name, seedLorebook = true } = request.body;  // Default true
    
    // ... character creation code ...
    
    // Only create lorebook if requested
    if (seedLorebook) {
        try {
            const lorebookName = await createSeededLorebook(/* ... */);
            // Link it...
        } catch (seedError) {
            console.error('[Character Seeding] Error:', seedError);
        }
    }
    
    // ... rest of code ...
});
```

---

## 🧪 DEMO: HOW IT WORKS IN PRACTICE

### **Scenario: Alice Creates a Character**

**Step 1: Alice creates "Elara the Wizard"**

```
Alice clicks "Create Character"
├── Name: Elara the Wizard
├── Description: A mysterious wizard...
└── ✅ Create private lorebook (checked)

Server processes:
├── Creates character: Elara_the_Wizard.png
├── Calls: createSeededLorebook("Elara the Wizard", "alice", dataRoot)
│   ├── Creates: USER-alice-Elara_the_Wizard.json
│   └── Content: Default starter entry
└── Links lorebook to character metadata
```

**Result:**
- Character file: `Elara_the_Wizard.png` (or .json)
- Lorebook file: `USER-alice-Elara_the_Wizard.json`
- Link: Character → Lorebook (in character's JSON metadata)

---

### **Step 2: Alice Edits the Lorebook**

```
Alice opens World Info
├── Sees: USER-alice-Elara_the_Wizard ✅ (it's her book)
├── Opens it
├── Adds entries:
│   ├── "Elara's secret: She was once human"
│   ├── "Elara's power: Fire magic"
│   └── "Elara's weakness: Water"
└── Saves
```

---

### **Step 3: Bob Uses the Character**

```
Bob opens character list
├── Sees: Elara the Wizard
├── Clicks to chat
└── Starts conversation

Behind the scenes:
├── Character loads: Elara_the_Wizard.png
├── Checks for linked lorebook: USER-alice-Elara_the_Wizard
├── Loads lorebook entries (even though Bob can't see them)
└── AI uses the lore in responses

Bob's view:
├── World Info menu
│   ├── Sees: PublicBooks, SHARED-Books ✅
│   └── Does NOT see: USER-alice-Elara_the_Wizard ❌
└── But Elara still acts according to her secret lore!
```

---

### **Step 4: Admin Checks**

```
Admin opens World Info
├── Sees: ALL books including USER-alice-Elara_the_Wizard ✅
├── Can review Alice's lore
├── Can edit if needed
└── Can ensure no inappropriate content
```

---

## 📊 VISIBILITY MATRIX

| User | Can Use Character | Can See Lorebook | Can Edit Lorebook |
|------|-------------------|------------------|-------------------|
| Alice (Creator) | ✅ Yes | ✅ Yes | ✅ Yes |
| Bob (Regular User) | ✅ Yes | ❌ No | ❌ No |
| Admin | ✅ Yes | ✅ Yes | ✅ Yes |

**The Magic:** Bob can chat with Elara and she uses the lore, but Bob can't see or edit it!

---

## 🔒 SECURITY & PERMISSIONS

### **What's Protected:**

1. **Lorebook visibility:** Filtered by `filterLorebooksForUser()` (already in your patched world-info.js)
2. **Lorebook editing:** Only creator + admin can edit
3. **Character usage:** Everyone can use the character

### **What's NOT Protected (yet):**

Without server-side middleware, a tech-savvy user COULD:
- Use browser console to bypass client-side filter
- Make direct API calls to read the lorebook

**Solution:** Add the server-side middleware I created earlier!

---

## 💡 ADVANCED FEATURES (Optional)

### **Feature 1: Auto-populate with character data**

```javascript
async function createSeededLorebook(characterName, creatorHandle, characterData, dataRoot) {
    // Use character's description to create default entries
    const lorebook = {
        // ...
        entries: {
            [uuidv4()]: {
                key: [characterName],
                content: `Character Background:\n${characterData.description}\n\nPersonality:\n${characterData.personality}`,
                // ... other fields
            }
        }
    };
    // ...
}
```

### **Feature 2: Shared creation (multiple owners)**

```javascript
const lorebookName = `SHARED-${cleanName}-by-${creatorHandle}`;
// Anyone can see, but add creator metadata for moderation
```

### **Feature 3: Template selection**

```javascript
const templates = {
    fantasy: { /* pre-filled fantasy lore entries */ },
    scifi: { /* pre-filled sci-fi lore entries */ },
    modern: { /* pre-filled modern lore entries */ }
};

async function createSeededLorebook(name, handle, template = 'fantasy', dataRoot) {
    const baseEntries = templates[template];
    // ... merge with lorebook
}
```

---

## 🧪 TESTING CHECKLIST

After implementing:

- [ ] Alice creates character → Lorebook auto-created ✅
- [ ] Alice opens World Info → Sees her lorebook ✅
- [ ] Alice edits lorebook → Saves successfully ✅
- [ ] Bob chats with character → Character uses lore ✅
- [ ] Bob opens World Info → Cannot see Alice's lorebook ✅
- [ ] Admin opens World Info → Sees Alice's lorebook ✅
- [ ] Character creation without checkbox → No lorebook created ✅

---

## 🆘 TROUBLESHOOTING

### Problem: Lorebook not created

**Check server logs:**
```bash
pm2 logs dreamtavern | grep "Character Seeding"
```

**Common causes:**
- Directory permissions
- Invalid character name (special chars)
- UUID module not imported

### Problem: Lorebook created but not linked

**Check character JSON:**
```bash
cat ~/SillyTavern/data/alice/characters/Elara_the_Wizard.json | grep "character_book"
```

Should show the lorebook link.

### Problem: Other users can still see it

**Check naming:**
- Must start with `USER-{handle}-`
- Handle must match exactly
- No typos in username

---

## 📦 COMPLETE EXAMPLE FILE

Here's a complete, ready-to-use implementation:

```javascript
// File: src/endpoints/characters.js
// Add to the top of the file:

import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs/promises';

/**
 * Creates a private seeded lorebook for a new character
 */
async function createSeededLorebook(characterName, creatorHandle, characterData, dataRoot) {
    const cleanName = characterName.replace(/[^a-zA-Z0-9-_]/g, '_').substring(0, 50);
    const lorebookName = `USER-${creatorHandle}-${cleanName}`;
    
    const defaultEntryId = uuidv4();
    const lorebook = {
        name: lorebookName,
        description: `Private lorebook for ${characterName}`,
        entries: {
            [defaultEntryId]: {
                uid: defaultEntryId,
                key: [characterName],
                keysecondary: [],
                comment: `Character: ${characterName}`,
                content: `[Private lore for ${characterName}]\n\nBackground: ${characterData.description || 'Add character background here.'}\n\nPersonality: ${characterData.personality || 'Add personality traits here.'}`,
                constant: true,
                selective: true,
                selectiveLogic: 0,
                order: 100,
                position: 0,
                disable: false,
                addMemo: true,
                excludeRecursion: false,
                delayUntilRecursion: false,
                probability: 100,
                useProbability: false,
                depth: 4,
                group: '',
                groupOverride: false,
                groupWeight: 100,
                scanDepth: null,
                caseSensitive: null,
                matchWholeWords: null,
                useGroupScoring: null,
                automationId: '',
                role: 0,
                vectorized: false,
                preventRecursion: false
            }
        }
    };
    
    const worldsDir = path.join(dataRoot, creatorHandle, 'worlds');
    await fs.mkdir(worldsDir, { recursive: true });
    
    const lorebookPath = path.join(worldsDir, `${lorebookName}.json`);
    await fs.writeFile(lorebookPath, JSON.stringify(lorebook, null, 2), 'utf8');
    
    console.log(`[Seeded Lorebook] Created: ${lorebookName}`);
    return lorebookName;
}

// In your character creation endpoint:
router.post('/create', jsonParser, async (request, response) => {
    try {
        const { name, description, personality, first_mes, seedLorebook = true } = request.body;
        const creatorHandle = request.user?.handle || 'default-user';
        const dataRoot = request.user?.directories?.root || globalThis.DATA_ROOT;
        
        // Create character file (your existing code)
        // ...
        
        // NEW: Seed lorebook if requested
        if (seedLorebook) {
            try {
                const lorebookName = await createSeededLorebook(
                    name,
                    creatorHandle,
                    { description, personality },
                    dataRoot
                );
                
                // Link lorebook in character metadata
                characterData.data = characterData.data || {};
                characterData.data.character_book = lorebookName;
                
                console.log(`[Seeded Lorebook] Linked ${lorebookName} to ${name}`);
            } catch (err) {
                console.error('[Seeded Lorebook] Error:', err);
                // Don't fail character creation
            }
        }
        
        // Save character (your existing code)
        // ...
        
        response.json({ success: true, character: name });
    } catch (error) {
        console.error('Character creation error:', error);
        response.status(500).json({ error: error.message });
    }
});
```

---

## 🎉 SUMMARY

**What You Get:**
- ✅ Auto-create private lorebook when character is created
- ✅ Only creator + admin can see/edit
- ✅ Everyone can use the character (lore applies)
- ✅ Clean naming: `USER-{creator}-{character}`
- ✅ Optional: Toggle on/off in UI

**Benefits:**
- 🔒 Privacy for character creators
- 🎨 Encourages detailed character lore
- 👥 Sharing characters without exposing lore secrets
- 🛡️ Admin oversight (can review all lore)

---

Want me to help you implement this? I can:
1. Write the exact code for your setup
2. Tell you exactly which files to edit
3. Walk you through testing it

Just let me know! 🚀
