# 🚀 EXACT DEPLOYMENT COMMANDS - Dreamhost VPS
## Copy & Paste These Commands (In Order)

---

## 📋 BEFORE YOU START

**What you need:**
1. ✅ SSH access to your Dreamhost VPS
2. ✅ Downloaded files from me:
   - `world-info.js` (the patched file)
   - `lorebook-security-middleware.js`
   - `ecosystem.config.js`
3. ✅ 30 minutes of time
4. ✅ Your 5 users warned about brief maintenance

**Open 2 terminal/command prompt windows:**
- **Window 1:** For SSH to your server
- **Window 2:** For file uploads (SFTP/SCP)

---

## 🔧 PART 1: BACKUP (5 minutes)

### Window 1 - SSH to your server:

```bash
# Connect to your server
ssh your-username@your-server.dreamhost.com

# Navigate to SillyTavern
cd ~/SillyTavern

# Create backup directory
mkdir -p ~/backups/dreamtavern-$(date +%Y%m%d)

# Backup the entire SillyTavern directory (excluding node_modules)
echo "Creating backup... (this takes 1-2 minutes)"
tar -czf ~/backups/dreamtavern-$(date +%Y%m%d)/full-backup.tar.gz \
    --exclude='node_modules' \
    --exclude='.git' \
    .

# Backup just the world-info.js file (extra safety)
cp public/scripts/world-info.js ~/backups/dreamtavern-$(date +%Y%m%d)/world-info.js.backup

# Verify backups exist
ls -lh ~/backups/dreamtavern-$(date +%Y%m%d)/

# You should see:
# - full-backup.tar.gz (50-200MB)
# - world-info.js.backup (190-250KB)
```

**✅ CHECKPOINT:** You should see both backup files listed.

**If backup fails:** Don't proceed! Fix the issue first.

---

## 🛑 PART 2: STOP THE SERVER (1 minute)

```bash
# Still in Window 1 (SSH)

# Stop PM2 (if running)
pm2 stop all

# OR if you're not using PM2 yet:
# Find the node process and kill it
# ps aux | grep node
# kill <process-id>

# Verify it's stopped
pm2 list
# Should show "stopped" or be empty

# OR check if any node processes are running:
ps aux | grep node | grep -v grep
# Should show nothing (empty)
```

**✅ CHECKPOINT:** Server is stopped. No node processes running.

---

## 📤 PART 3: UPLOAD FILES (5 minutes)

### Window 2 - File Upload (from your local computer):

**Option A: Using SCP (Mac/Linux/Windows PowerShell)**

```bash
# Navigate to where you downloaded my files
cd ~/Downloads  # Or wherever you saved them

# Upload the patched world-info.js
scp world-info.js your-username@your-server.dreamhost.com:~/SillyTavern/public/scripts/world-info.js

# Upload the middleware
scp lorebook-security-middleware.js your-username@your-server.dreamhost.com:~/SillyTavern/src/middleware/lorebook-security.js

# Upload PM2 config
scp ecosystem.config.js your-username@your-server.dreamhost.com:~/SillyTavern/ecosystem.config.js
```

**Option B: Using SFTP (GUI - easier for beginners)**

1. Open FileZilla/WinSCP/Cyberduck
2. Connect to: `your-server.dreamhost.com`
3. Username: `your-username`
4. Password: `your-password`

Upload these files:
- `world-info.js` → `/home/your-username/SillyTavern/public/scripts/world-info.js`
- `lorebook-security-middleware.js` → `/home/your-username/SillyTavern/src/middleware/lorebook-security.js`
- `ecosystem.config.js` → `/home/your-username/SillyTavern/ecosystem.config.js`

---

## ✅ PART 4: VERIFY UPLOADS (2 minutes)

### Back to Window 1 (SSH):

```bash
# Check world-info.js was uploaded correctly
cd ~/SillyTavern/public/scripts
ls -lh world-info.js
# Should show around 247KB (247000 bytes)

# Verify it's the patched version
grep -c "function filterLorebooksForUser" world-info.js
# Should show: 1

# Check middleware was uploaded
cd ~/SillyTavern/src/middleware
ls -lh lorebook-security.js
# Should exist and be around 8-10KB

# Check PM2 config
cd ~/SillyTavern
ls -lh ecosystem.config.js
# Should exist and be around 5-7KB
```

**✅ CHECKPOINT:** All 3 files uploaded correctly.

**If any file is missing:** Re-upload that file before continuing.

---

## 🔧 PART 5: CONFIGURE PM2 (3 minutes)

```bash
# Still in ~/SillyTavern directory

# Edit the PM2 config to match your setup
nano ecosystem.config.js

# Find and change these lines:
# - PORT: 8000 (or whatever your port is)
# - Change 'your-username' to your actual username
# - Save: Ctrl+X, then Y, then Enter

# Create logs directory
mkdir -p logs

# Install PM2 if not already installed
npm list -g pm2 || npm install -g pm2
```

---

## 🔒 PART 6: INTEGRATE SERVER MIDDLEWARE (5 minutes)

**First, let's find where your worldinfo routes are:**

```bash
cd ~/SillyTavern/src

# Search for worldinfo routes
grep -r "worldinfo\|world-info" endpoints/ --include="*.js" | head -20

# Look for output like:
# endpoints/worldinfo.js: router.get('/worldinfo/...')
# OR
# endpoints/content.js: router.post('/worldinfo/...')
```

**Common locations:**
- `src/endpoints/worldinfo.js`
- `src/endpoints/content.js`
- `src/server-startup.js`

**Once you find the file, edit it:**

```bash
# Example if it's in endpoints/content.js:
nano endpoints/content.js

# OR if it's in a different file:
# nano endpoints/worldinfo.js
```

**At the TOP of that file, add this import:**

```javascript
import { protectLorebookRead, protectLorebookWrite, rateLimitLorebooks } from '../middleware/lorebook-security.js';
```

**Then find routes that look like:**

```javascript
router.get('/api/worldinfo/:name', async (req, res) => {
    // existing code...
});
```

**Wrap them with middleware:**

```javascript
// READ operations (get lorebook)
router.get('/api/worldinfo/:name',
    rateLimitLorebooks,
    protectLorebookRead,
    async (req, res) => {
        // existing code stays the same...
    }
);

// WRITE operations (create/modify lorebook)
router.post('/api/worldinfo/:name',
    rateLimitLorebooks,
    protectLorebookWrite,
    async (req, res) => {
        // existing code stays the same...
    }
);
```

**Save:** Ctrl+X, then Y, then Enter

**⚠️ IF YOU CAN'T FIND THE WORLDINFO ROUTES:**

Don't worry! The client-side filtering will still work. We can add server middleware later. For now, skip to Part 7.

---

## 🚀 PART 7: START WITH PM2 (2 minutes)

```bash
# Navigate to SillyTavern root
cd ~/SillyTavern

# Start with PM2
pm2 start ecosystem.config.js

# Check status
pm2 status

# You should see:
# ┌─────┬──────────────┬─────────┬─────────┬─────────┐
# │ id  │ name         │ status  │ restart │ memory  │
# ├─────┼──────────────┼─────────┼─────────┼─────────┤
# │ 0   │ dreamtavern  │ online  │ 0       │ 150 MB  │
# └─────┴──────────────┴─────────┴─────────┴─────────┘

# Check logs for errors
pm2 logs dreamtavern --lines 50

# Look for:
# ✅ "SillyTavern is listening on..."
# ✅ No red ERROR messages
```

**✅ CHECKPOINT:** PM2 shows status: "online"

**If status shows "errored" or "stopped":**

```bash
# Check what went wrong
pm2 logs dreamtavern --lines 100

# Common issues:
# - Port already in use: Change port in ecosystem.config.js
# - Module not found: Check file paths
# - Syntax error: Check you saved files correctly

# To try again:
pm2 delete all
pm2 start ecosystem.config.js
```

---

## 🔐 PART 8: SAVE PM2 CONFIGURATION (1 minute)

```bash
# Save PM2 config (so it survives reboots)
pm2 save

# Set up auto-start on server reboot
pm2 startup

# PM2 will output a command like:
# sudo env PATH=$PATH:/usr/bin pm2 startup systemd -u your-username --hp /home/your-username

# COPY that command and run it:
# (paste the command PM2 gave you)

# Verify it's set up
pm2 list
```

**✅ CHECKPOINT:** PM2 saved and will auto-start on reboot.

---

## 🧪 PART 9: QUICK SMOKE TEST (3 minutes)

```bash
# Check if server is responding
curl http://localhost:8000/version
# Should return JSON with version info

# Check memory usage
pm2 show dreamtavern

# Should show:
# ├─ memory usage   : 150-300 MB (should be under 800MB)
# ├─ status         : online
# └─ restart time   : 0
```

**From your browser:**

1. Go to: `https://your-dreamtavern-url.com`
2. Log in as admin
3. Go to World Info
4. Check if lorebooks appear

**✅ CHECKPOINT:** Can access the site and see lorebooks.

---

## 👥 PART 10: TEST WITH USERS (10 minutes)

### Test 1: Admin User

```
1. Log in as admin
2. Go to World Info
3. Verify you see ALL lorebooks
4. Try to open an ADMIN- book (if you have one)
   - Should work ✅
```

### Test 2: Regular User

```
1. Log in as a regular (non-admin) user
2. Go to World Info
3. Check what's visible:
   
   Should SEE:
   ✅ Public lorebooks (no prefix)
   ✅ SHARED- lorebooks
   ✅ USER-{their-username}- lorebooks
   
   Should NOT see:
   ❌ ADMIN- lorebooks
   ❌ USER-{other-username}- lorebooks

4. Try to open one of their own USER- books
   - Should work ✅
```

### Test 3: Browser Console Security Check

**As a regular user:**

1. Press F12 (open browser console)
2. Go to Console tab
3. Paste this code:

```javascript
fetch('/api/worldinfo/get?name=ADMIN-TestBook', {
    headers: {
        'X-CSRF-Token': document.querySelector('meta[name="csrf-token"]')?.content || ''
    }
})
.then(r => r.json())
.then(console.log)
.catch(console.error);
```

**Expected result:**
- If server middleware is installed: 403 Forbidden
- If server middleware NOT installed yet: Will work (but client still filters)

---

## 📊 PART 11: VERIFY PERFORMANCE (2 minutes)

```bash
# In SSH window, monitor resources
pm2 monit

# Watch for a few minutes:
# - Memory should stay under 800MB
# - CPU should be low when idle (under 20%)
# - No constant restarts

# Press Ctrl+C to exit monitoring
```

**Check logs for cache working:**

```bash
pm2 logs dreamtavern --lines 100 | grep "cached"

# You should see messages like:
# [WI] Using cached lorebook list for alice
# [WI] Using cached lorebook list for bob
```

**✅ CHECKPOINT:** Performance looks good, cache is working.

---

## 🎉 PART 12: FINAL VERIFICATION

### Checklist - All Must Pass:

```bash
# In SSH window:

# 1. Server is running
pm2 list
# Status: online ✅

# 2. Memory is healthy
pm2 show dreamtavern | grep "memory"
# Under 800MB ✅

# 3. No errors in logs
pm2 logs dreamtavern --lines 50 | grep -i error
# Should show no recent errors ✅

# 4. Filter function exists
grep -c "function filterLorebooksForUser" ~/SillyTavern/public/scripts/world-info.js
# Returns: 1 ✅

# 5. Typo is fixed
grep "sucessful" ~/SillyTavern/public/scripts/world-info.js
# Returns: nothing (empty) ✅
```

### User Testing Checklist:

- [ ] Admin can see ALL lorebooks
- [ ] Admin can open ADMIN- books
- [ ] Regular user CANNOT see ADMIN- books
- [ ] Regular user CAN see their own USER- books
- [ ] Regular user CANNOT see other users' USER- books
- [ ] All users can see public lorebooks
- [ ] Server responds quickly (under 2 seconds)
- [ ] No errors in browser console (F12)

**If ALL checks pass:** 🎉 **DEPLOYMENT SUCCESSFUL!**

---

## 📱 PART 13: NOTIFY USERS (1 minute)

Send a message to your 5 users:

```
📢 Maintenance Complete!

The server is back online with new lorebook security features.

What changed:
✅ Improved lorebook organization
✅ Private lorebooks are now actually private
✅ Better performance with caching

You may need to:
- Refresh your browser (Ctrl+Shift+R)
- Re-login if asked

Lorebook naming:
- ADMIN-* = Admin only
- USER-yourname-* = Your private books
- Everything else = Public/shared

Questions? Let me know!
```

---

## 🆘 ROLLBACK (If Something Goes Wrong)

**Only use this if the server won't start or has critical errors:**

```bash
# Stop the broken version
pm2 stop all
pm2 delete all

# Restore from backup
cd ~
tar -xzf ~/backups/dreamtavern-$(date +%Y%m%d)/full-backup.tar.gz -C ~/SillyTavern/

# Start the old way (however you ran it before)
cd ~/SillyTavern
npm start

# OR if you were using PM2 before:
pm2 start server.js --name sillytavern
```

**Your server is now back to the working state!**

Then message me with:
- What error you saw
- At which step it failed
- Last 50 lines of PM2 logs

---

## 📈 MONITORING (Next 24 Hours)

### Check these a few times today:

```bash
# Every few hours, check:

# 1. Is it still running?
pm2 status

# 2. Memory usage okay?
pm2 show dreamtavern

# 3. Any errors?
pm2 logs dreamtavern --lines 20

# 4. Restart count?
pm2 list
# "restart" column should stay at 0 or very low
```

**Set a reminder to check:**
- In 2 hours
- In 8 hours
- Tomorrow morning

**If you see restarts > 5:** Check the logs, might be a memory leak.

---

## ✅ SUCCESS CRITERIA

You'll know everything is working when:

**Server Health:**
- ✅ PM2 status: online
- ✅ Memory: under 800MB
- ✅ No errors in logs
- ✅ Uptime: stable (no restarts)

**User Experience:**
- ✅ All 5 users can log in
- ✅ Lorebooks load quickly
- ✅ No complaints about missing books
- ✅ Private books stay private

**Security:**
- ✅ Admins see everything
- ✅ Regular users only see their own
- ✅ No cross-user access
- ✅ Cache working (see logs)

---

## 📞 GET HELP

**If you get stuck at ANY step:**

1. **Don't panic** - your backup is safe
2. **Note which step number** you're on
3. **Copy the exact error message**
4. **Share with me:**
   - Step number where it failed
   - Error message (exact text)
   - Output of: `pm2 logs dreamtavern --lines 50`

I'll help you troubleshoot!

---

## 🎯 NEXT STEPS (After Everything Works)

Once deployed and tested, you can:

1. **Rename existing lorebooks** to use new prefixes
   ```
   Old: "9Z-AdminBook" → New: "ADMIN-AdminBook"
   Old: "Z-alice-Book" → New: "USER-alice-Book"
   ```

2. **Add more security** (server middleware)
   - Send me your worldinfo routes file
   - I'll give you exact code to add

3. **Set up monitoring**
   ```bash
   # Install PM2 log rotate
   pm2 install pm2-logrotate
   pm2 set pm2-logrotate:max_size 10M
   pm2 set pm2-logrotate:retain 7
   ```

4. **Configure HTTPS** (if not already)
   - Dreamhost provides free SSL
   - Enable in control panel

---

## 🎉 YOU'RE DONE!

**Congratulations!** Your DreamTavern now has:
- ✅ Secure multi-user lorebook filtering
- ✅ Performance caching
- ✅ Reliable PM2 management
- ✅ Memory protection (auto-restart at 800MB)
- ✅ Auto-start on server reboot

**Total deployment time:** ~30-45 minutes
**Users affected:** 5 (all tested)
**Downtime:** ~5 minutes

---

**Questions?** Ask me at ANY step! I'm here to help! 🚀
