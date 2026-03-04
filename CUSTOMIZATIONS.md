# DreamTavern Customizations

This document details all modifications made to the base SillyTavern installation for the DreamTavern fork.

## Overview

DreamTavern is a customized multi-user SillyTavern instance with the following major features:
- **World Info Push System** - Admins can share lorebooks with specific users
- **Character Protection** - Prevents editing of pushed character definitions
- **Admin/User Permissions** - Role-based access control
- **Chat Chunking** - Handles large conversations (>750 messages)
- **Custom UI** - Branded loader, login, and fonts
- **LoreBot Push System** - Administrative interface for content distribution

---

## Modified Files

### Backend (src/endpoints/)

#### `src/endpoints/worldinfo.js`
**Major customization - Lorebook Push System**

Added functionality:
- `readPushManifest()` / `writePushManifest()` - Track pushed lorebooks
- `mergePushRecord()` - Update push history
- `POST /api/worldinfo/push` - Push lorebooks to users
- `GET /api/worldinfo/find-characters` - Find characters using a lorebook
- Auto-embed pushed lorebooks in recipient character cards
- Automatic sync when creator edits pushed lorebooks

#### `src/endpoints/characters.js`
**Major customization - Character Protection System**

Added functionality:
- `isUserBlockedFromAdvancedEdits()` - Check edit permissions
- `findCharactersByWorld()` - Lorebook-character relationships
- Protected fields: system_prompt, personality, scenario, depth_prompt_*, etc.
- Edit validation on PUT /api/characters/:id
- 403 Forbidden for unauthorized edits

#### `src/endpoints/settings.js`
**Minor customization**

Added functionality:
- User-specific settings paths
- Integration with multi-user authentication

---

### Frontend Scripts (public/scripts/)

#### `public/scripts/world-info.js`
**Major customization - Admin Controls & Hidden Lorebooks**

Added functionality:
- Import `isAdmin()` and `getCurrentUserHandle()` from user.js
- Admin-only push/share button visibility
- Hidden lorebook support for non-admin users
- "9z" prefix system for WorldInfoInfo extension integration
- `ensureWiiPanelObserver()` - MutationObserver for UI cleanup
- Permission-based lorebook displays

#### `public/scripts/chunking.js`
**NEW FILE - Chat Chunking System**

Features:
- Automatic detection of large chats (>750 messages)
- Splits chats into manageable chunks
- Transparent chunk reconstruction on load
- Prevents browser memory issues
- Maintains message order and integrity

---

### Frontend UI (public/)

#### `public/index.html`
**Modified - Push Buttons & Chunking Integration**

Changes:
- Added `#world_popup_share` button (Push to Users)
- Added `#world_bulk_push` button (Bulk Push Characters)
- Added `<script>` block to override `saveChat()` function
- Chunking system integration for large chats
- Buttons hidden by default, shown only to admins

---

### Stylesheets (public/css/)

#### `public/css/loader.css`
**Major customization - Magic Orb Loader**

Changes:
- Dark gradient background (#1a1a2e → #16213e → #0f0f23)
- Custom "magic orb" spinner design
- Soft mauve/lavender DreamTavern branding
- Animated pulsing glow effect
- Fantasy-themed aesthetic

#### `public/css/login.css`
**Modified - Branded Login Page**

Changes:
- Coordinated styling with loader gradient theme
- Enhanced visual consistency
- Responsive design maintained

#### `public/css/fonts.css`
**NEW FILE - Custom Web Fonts**

Added fonts:
- "Beau Rivage" - Elegant script (Beau-Rivage-regular.woff)
- "Bilbo Swash" - Decorative swash caps (Bilbo-Swash-Caps-regular.woff)
- "Island Moments" - Stylized display (Island-Moments-regular.woff)
- Fonts stored in `public/fonts/`

---

## New Directories

### `LoreBot_Push/`
**Administrative push system interface**

Contains:
- `PUSH-BOT-GUIDE.md` - Usage documentation
- `characters.js` - Character management for pushes
- `index.html` - Push bot admin interface
- `script.js` - Push bot logic
- `settings.js` - Configuration
- `style.css` - Styling
- `world-info.js` / `worldinfo.js` - Lorebook handling

### `World Info Implementation/`
**Documentation and deployment guides**

Contains:
- `00-START_HERE-OPUS_MASTER_DOCUMENT.md` - Main overview
- `01-world-info.js` - Implementation reference
- `02-SIMPLE_DEPLOYMENT.md` through `11-CRITICAL_ISSUES.md`
- Security middleware, deployment commands, testing checklists
- OpenAI integration fixes

---

## Asset Customizations

### Modified Images
- `public/favicon.ico` - DreamTavern favicon
- `public/img/logo.png` - DreamTavern logo
- `public/img/five.png` - Custom branding element
- `public/img/apple-icon-*.png` - iOS app icons (various sizes)
- `public/st-launcher.ico` - Launcher icon
- `public/st.ico` - Application icon

---

## Permission System

### Admin Users
- Can push/share lorebooks to any users
- Full edit access to all content
- See all lorebooks regardless of visibility
- Can bulk push characters
- Access to LoreBot_Push administrative interface

### Regular Users
- Cannot push/share lorebooks
- Cannot edit "Advanced Definitions" on pushed characters
- See pushed lorebooks as character-embedded (locked)
- Hidden lorebooks show as "(hidden entries)" placeholder
- Can still edit own characters and lorebooks

---

## Data Structure

### Push Manifest
**Location**: `data/{username}/push-manifest.json`

Structure:
```json
[
  {
    "source_lorebook": "original_lorebook_name.json",
    "pushed_lorebook_name": "displayed_name_for_recipients",
    "character_files": ["character1.png", "character2.png"],
    "recipients": ["user1", "user2", "user3"]
  }
]
```

---

## Technical Implementation Details

### Lorebook Push Flow
1. Admin selects lorebook in World Info panel
2. Clicks "Push to Users" button
3. Selects recipients (specific users or "all")
4. Backend creates push manifest entry
5. Lorebook embedded in specified character cards
6. Recipients see lorebook as character-seeded (locked)
7. Future edits by creator auto-sync to recipients

### Chat Chunking Flow
1. User saves chat with >750 messages
2. `public/index.html` overridden `saveChat()` detects size
3. Calls `window.chatChunker.saveLargeChat()`
4. Chat split into chunks, saved separately
5. On load, chunks reassembled transparently
6. User experience unchanged

### Hidden Lorebook Display
1. Non-admin user loads character with hidden lorebook
2. `public/scripts/world-info.js` prefixes name with "9z"
3. WorldInfoInfo extension recognizes "9z" prefix
4. Extension collapses to "(hidden entries)" placeholder
5. MutationObserver strips "9z" from UI display
6. Badge count remains accurate

---

## File Relationship Map

```
Lorebook Push System:
├── public/index.html (push buttons)
├── public/scripts/world-info.js (frontend logic + admin checks)
├── src/endpoints/worldinfo.js (backend push API)
├── src/endpoints/characters.js (character protection)
└── data/{user}/push-manifest.json (tracking)

Chat Chunking:
├── public/index.html (saveChat override)
└── public/scripts/chunking.js (chunk management)

UI Branding:
├── public/css/loader.css (magic orb)
├── public/css/login.css (login page)
├── public/css/fonts.css (custom fonts)
├── public/fonts/*.woff (font files)
└── public/img/* (logos, icons)

Admin Tools:
└── LoreBot_Push/* (admin interface)
```

---

## Testing Checklist

- [ ] Admin can push lorebook to specific user
- [ ] Admin can push lorebook to all users
- [ ] Non-admin user cannot access push buttons
- [ ] Pushed lorebook appears as character-seeded for recipient
- [ ] Recipient cannot edit advanced definitions on pushed character
- [ ] Creator edits to pushed lorebook sync to recipients
- [ ] Chat >750 messages saves via chunking
- [ ] Chunked chat loads correctly with all messages intact
- [ ] Hidden lorebooks show as "(hidden entries)" for non-admin
- [ ] Custom loader displays on page load
- [ ] Custom fonts load correctly

---

## Maintenance Notes

### Updating Pushed Content
When a creator edits a pushed lorebook:
1. Changes automatically saved to original file
2. Backend checks push manifest
3. Updated lorebook embedded in all recipient character cards
4. Recipients see changes on next character load

### Adding New Fonts
1. Add .woff file to `public/fonts/`
2. Add @font-face declaration to `public/css/fonts.css`
3. Use font-family name in other stylesheets

### Granting Admin Access
Admin status controlled by `src/users.js` authentication system.
Consult SillyTavern multi-user documentation for user management.

---

## Compatibility Notes

- Based on SillyTavern release branch
- Requires multi-user mode enabled
- WorldInfoInfo extension recommended for hidden lorebook feature
- Modern browser required for MutationObserver support
- Font files use WOFF format for broad compatibility

---

## Future Enhancement Ideas

- Push revoke/unpush functionality
- Version control for pushed content
- Push notification system for recipients
- Enhanced admin dashboard in LoreBot_Push
- Configurable chunk size threshold
- Compressed chunk storage

---

**Last Updated**: March 3, 2026  
**Fork Maintainer**: DreamTavern Team  
**Base Version**: SillyTavern Release Branch
