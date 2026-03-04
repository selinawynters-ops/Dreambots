# EXACT FIX for openai.js - Line 104

## 🎯 THE PROBLEM:

Multi-line strings with regular quotes cause "SyntaxError: Unexpected token"

## ✅ THE SOLUTION:

Replace line 104 with ONE of these options:

---

## OPTION 1: Simple & Safe (RECOMMENDED)

```javascript
const default_wi_format = '[WORLD INFO - IMPORTANT]\n{0}\n[Follow these facts in your responses.]';
```

**Benefits:**
- ✅ Single line (no syntax errors)
- ✅ Adds helpful context
- ✅ Easy to type/paste
- ✅ Works on mobile

---

## OPTION 2: Stronger (If Option 1 isn't enough)

```javascript
const default_wi_format = '[CRITICAL LORE - MANDATORY]\nThe following information is absolute truth. You MUST follow these rules:\n\n{0}\n\n[END MANDATORY LORE - Do not contradict the above.]';
```

**Benefits:**
- ✅ More emphatic
- ✅ Still single line
- ✅ Clear instructions

---

## OPTION 3: Using Template Literals (Most Readable)

```javascript
const default_wi_format = `[WORLD INFO - FOLLOW STRICTLY]
The following information represents facts about this world.
You MUST adhere to these rules in all responses:

{0}

[END WORLD INFO]`;
```

**CRITICAL:** Must use **BACKTICKS** `` ` `` (not quotes `'` or `"`)

**Benefits:**
- ✅ Multi-line without errors
- ✅ Very readable
- ✅ Most professional

**Risks:**
- ⚠️ Easy to type wrong quote on mobile
- ⚠️ Backtick key is hard to find on some keyboards

---

## 🚀 EXACT STEPS TO FIX:

```bash
# 1. SSH to your server
ssh your-username@your-server.dreamhost.com

# 2. Stop the server (important!)
cd ~/SillyTavern
pm2 stop dreamtavern

# 3. Edit the file
nano public/scripts/openai.js

# 4. Press Ctrl+W (search)
# Type: default_wi_format
# Press Enter

# 5. You'll see line 104:
# const default_wi_format = '{0}';

# 6. Delete that entire line

# 7. Type this EXACTLY (copy-paste if possible):
const default_wi_format = '[WORLD INFO - IMPORTANT]\n{0}\n[Follow these facts in your responses.]';

# 8. Save: Ctrl+X, then Y, then Enter

# 9. Verify syntax is correct:
node -c public/scripts/openai.js

# If you see nothing = GOOD! ✅
# If you see "SyntaxError" = Try again ❌

# 10. Start server:
pm2 start dreamtavern

# 11. Check logs:
pm2 logs dreamtavern --lines 20
```

---

## 🔍 VERIFICATION:

After restarting, check if it worked:

```bash
# Should see "online" status
pm2 status

# Should see no syntax errors
pm2 logs dreamtavern --lines 50 | grep -i "syntax"

# Try accessing the site
curl http://localhost:8000/version
```

---

## 📱 TYPING TIP FOR MOBILE:

If editing on mobile:

**For `\n` (backslash-n):**
1. Long-press the backslash key `\`
2. Type `n`

**DO NOT try to type actual line breaks!**

---

## 🆘 IF IT STILL BREAKS:

If you get another syntax error:

```bash
# Restore original immediately
cd ~/SillyTavern/public/scripts
cp openai.js openai.js.broken
git checkout openai.js

# Or if not using git:
# Just re-download the original file from GitHub
```

Then **SKIP the wi_format change completely** - it's optional!

---

## 💡 MY RECOMMENDATION:

**Since you're on mobile and it broke once:**

1. **Keep openai.js default** (don't change it)
2. **Focus on world-info.js** (the filtering - more important!)
3. **Test lorebooks** with default format
4. **Change wi_format later** from a desktop if needed

**The filtering is essential. The formatting is nice-to-have.**

---

## ✅ WHICH OPTION SHOULD YOU USE?

| Option | Best For | Safety |
|--------|----------|--------|
| **Option 1** | Mobile editing | ⭐⭐⭐⭐⭐ Safest |
| **Option 2** | Stronger instructions | ⭐⭐⭐⭐ Very safe |
| **Option 3** | Desktop editing | ⭐⭐⭐ Safe if typed correctly |

**For you right now:** Use **Option 1** - simplest and safest.

---

## 🎯 READY TO TRY?

Want to try Option 1 (the safest)? Or should we just skip the wi_format change and focus on deploying world-info.js instead?
