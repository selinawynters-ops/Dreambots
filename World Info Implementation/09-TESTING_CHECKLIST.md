# DreamTavern Testing Checklist
## Post-Deployment Verification

Complete these tests IN ORDER before allowing users back on the system.

---

## 🎯 TEST ENVIRONMENT

**Server:** Dreamhost VPS (2GB RAM, 2 CPU)
**Users:** 5 active users
**Test Duration:** 15-20 minutes

---

## ✅ PHASE 1: SERVER HEALTH (5 minutes)

### Test 1.1: Server is Running
```bash
pm2 list
```
**Expected:** `dreamtavern` shows status: `online`
**Status:** [ ] PASS [ ] FAIL

### Test 1.2: Memory Usage is Normal
```bash
pm2 monit
# Or
pm2 show dreamtavern
```
**Expected:** Memory usage < 800MB
**Actual Memory:** _________ MB
**Status:** [ ] PASS [ ] FAIL

### Test 1.3: No Critical Errors in Logs
```bash
pm2 logs dreamtavern --lines 50
```
**Expected:** No red ERROR messages, see "SillyTavern is listening..."
**Status:** [ ] PASS [ ] FAIL

### Test 1.4: Server Responds to HTTP
```bash
curl http://localhost:8000/version
# Or whatever your port is
```
**Expected:** JSON response with version info
**Status:** [ ] PASS [ ] FAIL

---

## 👤 PHASE 2: ADMIN USER TESTING (5 minutes)

### Test 2.1: Admin Can Log In
- Navigate to: https://your-dreamtavern.com
- Log in as admin user
- **Expected:** Successful login
- **Status:** [ ] PASS [ ] FAIL

### Test 2.2: Admin Sees All Lorebooks
- Click on "World Info" or lorebook menu
- **Expected:** See ALL lorebooks including:
  - ADMIN- prefixed lorebooks ✓
  - USER- prefixed lorebooks ✓
  - Public lorebooks ✓
  - SHARED- prefixed lorebooks ✓
- **Total lorebooks visible:** _________
- **Status:** [ ] PASS [ ] FAIL

### Test 2.3: Admin Can Open ADMIN- Lorebook
- Try to open a lorebook starting with `ADMIN-`
- **Expected:** Opens successfully, can view/edit entries
- **Status:** [ ] PASS [ ] FAIL

### Test 2.4: Admin Can Open USER- Lorebook (Not Their Own)
- Try to open a lorebook like `USER-bob-Something` (where bob is not you)
- **Expected:** Opens successfully
- **Status:** [ ] PASS [ ] FAIL

### Test 2.5: Admin Can Create New Lorebook
- Create a new lorebook named: `ADMIN-TestBook`
- **Expected:** Created successfully
- **Status:** [ ] PASS [ ] FAIL

---

## 👥 PHASE 3: REGULAR USER TESTING (10 minutes)

### For Each of Your 5 Users:

#### User 1: __________ (username)

**Test 3.1: User Can Log In**
- **Status:** [ ] PASS [ ] FAIL

**Test 3.2: User CANNOT See ADMIN- Lorebooks**
- Open World Info
- Look for ADMIN- prefixed lorebooks
- **Expected:** NONE visible (should be hidden)
- **Actual:** _________
- **Status:** [ ] PASS [ ] FAIL

**Test 3.3: User CAN See Their Own USER- Lorebooks**
- Look for lorebooks named `USER-{this-user}-*`
- **Expected:** All visible
- **Count visible:** _________
- **Status:** [ ] PASS [ ] FAIL

**Test 3.4: User CANNOT See Other Users' USER- Lorebooks**
- Look for lorebooks named `USER-{other-user}-*`
- **Expected:** NONE visible (should be hidden)
- **Status:** [ ] PASS [ ] FAIL

**Test 3.5: User CAN See Public Lorebooks**
- Look for lorebooks with no prefix or SHARED- prefix
- **Expected:** All visible
- **Status:** [ ] PASS [ ] FAIL

**Test 3.6: User Can Open Their Own USER- Lorebook**
- Try to open `USER-{this-user}-Something`
- **Expected:** Opens successfully
- **Status:** [ ] PASS [ ] FAIL

**Test 3.7: Server-Side Security Check (Advanced)**
Open browser console (F12 → Console tab), then run:
```javascript
// Try to access an ADMIN lorebook (should fail)
fetch('/api/worldinfo/get?name=ADMIN-TestBook', {
    headers: {
        'X-CSRF-Token': document.querySelector('meta[name="csrf-token"]')?.content || ''
    }
})
.then(r => r.json())
.then(console.log)
.catch(console.error);
```
- **Expected:** 403 Forbidden error or "Access denied"
- **Actual:** _________
- **Status:** [ ] PASS [ ] FAIL

**Test 3.8: User Can Create Their Own USER- Lorebook**
- Create a new lorebook named: `USER-{this-user}-TestBook`
- **Expected:** Created successfully
- **Status:** [ ] PASS [ ] FAIL

---

#### User 2: __________ (username)

Repeat Tests 3.1-3.8:
- Test 3.1: [ ] PASS [ ] FAIL
- Test 3.2: [ ] PASS [ ] FAIL
- Test 3.3: [ ] PASS [ ] FAIL
- Test 3.4: [ ] PASS [ ] FAIL
- Test 3.5: [ ] PASS [ ] FAIL
- Test 3.6: [ ] PASS [ ] FAIL
- Test 3.7: [ ] PASS [ ] FAIL
- Test 3.8: [ ] PASS [ ] FAIL

---

#### User 3: __________ (username)

Repeat Tests 3.1-3.8:
- Test 3.1: [ ] PASS [ ] FAIL
- Test 3.2: [ ] PASS [ ] FAIL
- Test 3.3: [ ] PASS [ ] FAIL
- Test 3.4: [ ] PASS [ ] FAIL
- Test 3.5: [ ] PASS [ ] FAIL
- Test 3.6: [ ] PASS [ ] FAIL
- Test 3.7: [ ] PASS [ ] FAIL
- Test 3.8: [ ] PASS [ ] FAIL

---

#### User 4: __________ (username)

Repeat Tests 3.1-3.8:
- Test 3.1: [ ] PASS [ ] FAIL
- Test 3.2: [ ] PASS [ ] FAIL
- Test 3.3: [ ] PASS [ ] FAIL
- Test 3.4: [ ] PASS [ ] FAIL
- Test 3.5: [ ] PASS [ ] FAIL
- Test 3.6: [ ] PASS [ ] FAIL
- Test 3.7: [ ] PASS [ ] FAIL
- Test 3.8: [ ] PASS [ ] FAIL

---

#### User 5: __________ (username)

Repeat Tests 3.1-3.8:
- Test 3.1: [ ] PASS [ ] FAIL
- Test 3.2: [ ] PASS [ ] FAIL
- Test 3.3: [ ] PASS [ ] FAIL
- Test 3.4: [ ] PASS [ ] FAIL
- Test 3.5: [ ] PASS [ ] FAIL
- Test 3.6: [ ] PASS [ ] FAIL
- Test 3.7: [ ] PASS [ ] FAIL
- Test 3.8: [ ] PASS [ ] FAIL

---

## 🚀 PHASE 4: PERFORMANCE TESTING (5 minutes)

### Test 4.1: Multiple Users Can Connect Simultaneously
- Have 3-5 users log in at the same time
- **Expected:** All can log in, no slowdown
- **Status:** [ ] PASS [ ] FAIL

### Test 4.2: Lorebook Loading is Fast
- Load a large lorebook (if you have one)
- **Expected:** Loads in < 2 seconds
- **Actual load time:** _________ seconds
- **Status:** [ ] PASS [ ] FAIL

### Test 4.3: Memory Stays Stable Under Load
```bash
# While multiple users are active:
pm2 monit
```
- **Expected:** Memory stays under 800MB even with all users active
- **Peak memory:** _________ MB
- **Status:** [ ] PASS [ ] FAIL

### Test 4.4: Cache is Working (Check Logs)
```bash
pm2 logs dreamtavern --lines 100 | grep "Using cached"
```
- **Expected:** See log messages about using cached lorebook lists
- **Status:** [ ] PASS [ ] FAIL

---

## 🔒 PHASE 5: SECURITY TESTING (5 minutes)

### Test 5.1: Rate Limiting Works
As a regular user, rapidly refresh the lorebook list 35+ times in 1 minute.
- **Expected:** After ~30 requests, get "Too many requests" error (429)
- **Status:** [ ] PASS [ ] FAIL

### Test 5.2: Direct API Access is Blocked
Try to access a restricted file directly via URL:
```
https://your-dreamtavern.com/api/worldinfo/get?name=ADMIN-TestBook
```
(While logged in as regular user)
- **Expected:** 403 Forbidden
- **Status:** [ ] PASS [ ] FAIL

### Test 5.3: Security Logging Works
```bash
pm2 logs dreamtavern | grep "Security"
```
- **Expected:** See security log entries for denied access attempts
- **Status:** [ ] PASS [ ] FAIL

---

## 🔄 PHASE 6: RELIABILITY TESTING (Optional - 10 minutes)

### Test 6.1: Server Auto-Restarts on Crash
```bash
# Simulate a crash
pm2 stop dreamtavern

# Wait 5 seconds
sleep 5

# Check status
pm2 list
```
- **Expected:** PM2 automatically restarted it (shows "online")
- **Status:** [ ] PASS [ ] FAIL

### Test 6.2: Server Auto-Restarts on High Memory
This happens automatically when memory > 800MB. Monitor over time.
```bash
pm2 logs dreamtavern --lines 10
```
- **Expected:** Eventually see "Process X stopped" then "Process X started" messages
- **Status:** [ ] Will test over 24 hours

### Test 6.3: Server Survives Server Reboot
```bash
# Reboot the VPS
sudo reboot

# Wait 2 minutes, then SSH back in and check:
pm2 list
```
- **Expected:** dreamtavern is running (auto-started)
- **Status:** [ ] PASS [ ] FAIL [ ] SKIP (will test later)

---

## 📊 FINAL SCORE

**Total Tests:** 45+
**Passed:** _________ / 45
**Failed:** _________ / 45
**Skipped:** _________ / 45

### Minimum Passing Criteria:
- ✅ All Phase 1 tests must pass (Server Health)
- ✅ All Phase 2 tests must pass (Admin functionality)
- ✅ At least 90% of Phase 3 tests must pass (User isolation)
- ✅ No critical security failures in Phase 5

---

## 🚨 FAILURE SCENARIOS

### If Phase 1 Fails:
**Action:** Do NOT proceed. Check server logs and fix issues first.

### If Phase 2 Fails:
**Action:** Admin functionality broken. Check world-info.js patch.

### If Phase 3 Tests Fail for ANY User:
**Action:** Security issue! Users can see lorebooks they shouldn't.
**Fix:** Check both client-side filter AND server-side middleware.

### If Phase 5 Tests Fail:
**Action:** CRITICAL security vulnerability!
**Fix:** Server-side middleware not working. Check integration.

---

## ✅ SIGN-OFF

**Tester Name:** _________________________

**Date:** _________________________

**Time:** _________________________

**Overall Status:** [ ] PASS [ ] FAIL

**Deployment Approved:** [ ] YES [ ] NO

**Notes:**
_____________________________________________________________________________
_____________________________________________________________________________
_____________________________________________________________________________
_____________________________________________________________________________

---

## 📝 POST-TEST ACTIONS

If all tests pass:
- [ ] Notify all 5 users that maintenance is complete
- [ ] Document any issues found and how they were resolved
- [ ] Schedule first monitoring check for tomorrow
- [ ] Set calendar reminder for weekly health checks

If tests fail:
- [ ] Review failure logs
- [ ] Consult DEPLOYMENT_GUIDE.md troubleshooting section
- [ ] Consider rollback if critical failures
- [ ] Contact support if needed

---

**Remember:** Security is not a one-time setup. Monitor regularly!
