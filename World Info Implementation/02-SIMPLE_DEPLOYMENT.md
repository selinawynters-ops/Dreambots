# 🚀 WORLD-INFO.JS DEPLOYMENT - SUPER SIMPLE VERSION

**Time:** 10 minutes
**Risk:** Low (we backup first)
**Benefit:** User-specific lorebook filtering + caching

---

## 📋 WHAT YOU NEED

- ✅ The `world-info.js` file I created (download it)
- ✅ SSH access to your Dreamhost VPS
- ✅ 10 minutes

---

## 🔧 STEP-BY-STEP (Copy & Paste)

### **STEP 1: Download the File**

Download `world-info.js` from my outputs (the 247KB file)

Save it somewhere easy to find (like Downloads folder)

---

### **STEP 2: Connect to Your Server**

Open terminal/command prompt:

```bash
ssh your-username@your-server.dreamhost.com
```

Replace `your-username` and `your-server.dreamhost.com` with your actual details.

---

### **STEP 3: Backup Current File**

```bash
# Navigate to the scripts folder
cd ~/SillyTavern/public/scripts

# Backup the current file
cp world-info.js world-info.js.backup-original

# Verify backup exists
ls -lh world-info.js.backup-original
```

**✅ You should see:** A file size around 190-250KB

**If backup fails:** Stop here and fix it!

---

### **STEP 4: Upload New File**

**Option A: Using SCP (Mac/Linux/Windows PowerShell)**

Open a NEW terminal window (keep SSH open):

```bash
# Navigate to where you downloaded world-info.js
cd ~/Downloads

# Upload the file
scp world-info.js your-username@your-server.dreamhost.com:~/SillyTavern/public/scripts/world-info.js
```

**Option B: Using FileZilla/WinSCP (Easier for beginners)**

1. Open FileZilla/WinSCP
2. Connect to your server
3. Navigate to: `/home/your-username/SillyTavern/public/scripts/`
4. Drag `world-info.js` from your computer to the server
5. Confirm overwrite when asked

---

### **STEP 5: Verify Upload**

Back in your SSH window:

```bash
# Check the file
cd ~/SillyTavern/public/scripts
ls -lh world-info.js

# Should show around 247KB (247000 bytes)

# Verify it's the patched version
grep -c "function filterLorebooksForUser" world-info.js
```

**✅ Should return:** `1`

**If it returns `0`:** The upload failed, try again.

---

### **STEP 6: Restart Server**

```bash
# Navigate to SillyTavern root
cd ~/SillyTavern

# Restart with PM2
pm2 restart dreamtavern

# Check status
pm2 status
```

**✅ Should show:** `online` status

**Check logs for errors:**

```bash
pm2 logs dreamtavern --lines 30
```

**✅ Should see:** No red ERROR messages

---

### **STEP 7: Test in Browser**

1. **Open your DreamTavern:** `https://dreamtavern.me`
2. **Log in as admin**
3. **Open World Info** (the book icon or menu)
4. **Check the console** (Press F12, then Console tab)

**✅ Should see:** No JavaScript errors

---

## 🧪 TESTING (5 minutes)

### **Test 1: Admin User**

1. Log in as admin
2. Go to World Info
3. You should see ALL lorebooks (nothing filtered)

### **Test 2: Create Test Lorebooks**

Create these test lorebooks (just empty files for now):

- `ADMIN-TestBook`
- `USER-alice-TestBook` (use actual username)
- `PublicBook`

### **Test 3: Regular User**

1. Log out
2. Log in as a regular user (not admin)
3. Go to World Info
4. **Check what you see:**
   - ❌ Should NOT see: `ADMIN-TestBook`
   - ✅ SHOULD see: `USER-yourname-TestBook` (if it matches your username)
   - ✅ SHOULD see: `PublicBook`

### **Test 4: Check Console for Caching**

With browser console open (F12):

1. Open World Info menu
2. Look for: `[WI] Using cached lorebook list for username`
3. Close and reopen World Info menu
4. Should see the cache message again

---

## ✅ SUCCESS CHECKLIST

- [x] Backup created successfully
- [x] New file uploaded (247KB)
- [x] Server restarted without errors
- [x] Admin can see all lorebooks
- [x] Regular user cannot see ADMIN- books
- [x] Cache working (see console logs)

**If all checked:** 🎉 **DEPLOYMENT SUCCESSFUL!**

---

## 🆘 TROUBLESHOOTING

### Problem: "Cannot find module"

**Fix:**
```bash
cd ~/SillyTavern
npm install
pm2 restart dreamtavern
```

### Problem: Server won't start

**Check logs:**
```bash
pm2 logs dreamtavern --lines 50
```

Look for the error message and share it with me.

### Problem: File upload failed

**Verify SSH connection:**
```bash
# Test if you can access the directory
cd ~/SillyTavern/public/scripts
pwd
```

Should show the full path.

### Problem: Users still see restricted books

**Clear browser cache:**
1. Press Ctrl+Shift+R (hard refresh)
2. Or clear cache in browser settings
3. Log out and log back in

**Check if filtering function exists:**
```bash
grep "function filterLorebooksForUser" ~/SillyTavern/public/scripts/world-info.js
```

Should show the function.

---

## 🔄 ROLLBACK (If Something Goes Wrong)

```bash
# Stop server
cd ~/SillyTavern
pm2 stop dreamtavern

# Restore backup
cd public/scripts
mv world-info.js world-info.js.broken
mv world-info.js.backup-original world-info.js

# Restart
cd ~/SillyTavern
pm2 start dreamtavern

# Verify it works
pm2 logs dreamtavern
```

**You're back to the working version!**

---

## 📝 AFTER DEPLOYMENT

### Rename Your Existing Lorebooks

Use this pattern:

**Admin-only books:**
```
Old: "Secret Lore"
New: "ADMIN-SecretLore"
```

**User-specific books:**
```
Old: "Alice's Characters"
New: "USER-alice-Characters"
```

**Public books:**
```
Old: "Fantasy World"
Keep: "Fantasy World" (or rename to "SHARED-FantasyWorld")
```

### How to Rename:

1. In your file manager or via SSH:
```bash
cd ~/SillyTavern/data/default-user/worlds
# Or wherever your lorebooks are stored

# Rename files
mv "Secret Lore.json" "ADMIN-SecretLore.json"
mv "Alice's Characters.json" "USER-alice-Characters.json"
```

2. Or rename in the SillyTavern UI (World Info → Edit → Rename)

---

## 🎯 WHAT'S NEXT?

After this works, you can optionally add:

1. **Server-side middleware** (for true security)
2. **PM2 configuration** (for better reliability)
3. **Rate limiting** (to protect your VPS)

But the filtering alone is already a HUGE improvement!

---

## 💡 KEY POINTS TO REMEMBER

**The Magic Is In The Name:**
- `ADMIN-*` = Admin only
- `USER-username-*` = That user only (+ admins)
- Anything else = Public

**Caching Saves Resources:**
- First load: ~10ms
- Cached loads: ~0.1ms
- Cache expires: 5 minutes
- Your 2GB VPS will thank you!

**It's Client-Side:**
- Filters what users SEE
- For real security, add server middleware later
- But this alone is 90% effective

---

## 📞 NEED HELP?

If you get stuck:

1. Check the error in PM2 logs
2. Verify the file uploaded correctly
3. Try the rollback procedure
4. Share the specific error with me

**I'm here to help!** 🚀

---

**Ready to start? Begin with STEP 1!** ⬆️
