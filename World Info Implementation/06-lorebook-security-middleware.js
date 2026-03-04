/**
 * Server-side lorebook security middleware for DreamTavern
 * 
 * This middleware provides TRUE security by checking permissions on the server
 * before serving lorebook files. Client-side filtering can be bypassed, but
 * this cannot.
 * 
 * Installation:
 * 1. Save this file as: src/middleware/lorebook-security.js
 * 2. Import in server-startup.js or wherever worldinfo routes are defined
 * 3. Apply to all lorebook-related routes
 */

/**
 * Checks if a user has permission to access a specific lorebook
 * @param {string} lorebookName - Name of the lorebook file
 * @param {import('../users.js').UserViewModel} user - Current user object
 * @returns {boolean} True if user can access this lorebook
 */
export function canAccessLorebook(lorebookName, user) {
    // Admins can access everything
    if (user && user.admin) {
        return true;
    }

    // If no user (shouldn't happen with requireLoginMiddleware, but just in case)
    if (!user) {
        return false;
    }

    const userHandle = user.handle;

    // Check ADMIN- prefix (admin-only lorebooks)
    if (lorebookName.startsWith('ADMIN-')) {
        return false; // Non-admins cannot access
    }

    // Check USER-{handle}- prefix (user-specific lorebooks)
    const userMatch = lorebookName.match(/^USER-([^-]+)-/);
    if (userMatch) {
        // Only the owner (or admin, already checked above) can access
        return userMatch[1] === userHandle;
    }

    // SHARED- prefix or no prefix = public lorebook
    return true;
}

/**
 * Express middleware to protect lorebook GET/read operations
 * Use this on routes that serve lorebook files
 */
export function protectLorebookRead(req, res, next) {
    const lorebookName = req.params.name || req.query.name || req.body?.name;
    
    if (!lorebookName) {
        return res.status(400).json({ error: 'Lorebook name required' });
    }

    const user = req.user;
    
    if (!canAccessLorebook(lorebookName, user)) {
        console.warn(`[Security] User ${user?.handle || 'unknown'} attempted to access restricted lorebook: ${lorebookName}`);
        return res.status(403).json({ error: 'Access denied' });
    }

    // Permission granted, continue to the actual route handler
    next();
}

/**
 * Express middleware to protect lorebook WRITE/modify operations
 * Use this on routes that create, update, or delete lorebooks
 */
export function protectLorebookWrite(req, res, next) {
    const lorebookName = req.params.name || req.query.name || req.body?.name;
    
    if (!lorebookName) {
        return res.status(400).json({ error: 'Lorebook name required' });
    }

    const user = req.user;

    // Only admins can modify ADMIN- lorebooks
    if (lorebookName.startsWith('ADMIN-') && !user?.admin) {
        console.warn(`[Security] User ${user?.handle || 'unknown'} attempted to modify admin lorebook: ${lorebookName}`);
        return res.status(403).json({ error: 'Admin access required' });
    }

    // Users can only modify their own USER- lorebooks
    const userMatch = lorebookName.match(/^USER-([^-]+)-/);
    if (userMatch && userMatch[1] !== user?.handle && !user?.admin) {
        console.warn(`[Security] User ${user?.handle || 'unknown'} attempted to modify another user's lorebook: ${lorebookName}`);
        return res.status(403).json({ error: 'Can only modify your own lorebooks' });
    }

    // Public/shared lorebooks can be modified by anyone (or restrict as needed)
    // If you want to restrict public lorebook modification, add logic here

    next();
}

/**
 * Filters a list of lorebook names based on user permissions
 * Use this for API endpoints that return lists of available lorebooks
 * @param {string[]} lorebookNames - Array of all lorebook names
 * @param {import('../users.js').UserViewModel} user - Current user object
 * @returns {string[]} Filtered array of accessible lorebooks
 */
export function filterLorebookList(lorebookNames, user) {
    if (!Array.isArray(lorebookNames)) {
        return [];
    }

    // Admins see everything
    if (user && user.admin) {
        return lorebookNames;
    }

    const userHandle = user?.handle;
    if (!userHandle) {
        // No user = only public lorebooks
        return lorebookNames.filter(name => 
            !name.startsWith('ADMIN-') && 
            !name.match(/^USER-([^-]+)-/)
        );
    }

    return lorebookNames.filter(name => {
        // Hide admin lorebooks
        if (name.startsWith('ADMIN-')) {
            return false;
        }

        // Show user's own lorebooks
        const userMatch = name.match(/^USER-([^-]+)-/);
        if (userMatch) {
            return userMatch[1] === userHandle;
        }

        // Show public lorebooks
        return true;
    });
}

/**
 * Rate limiting for lorebook operations (VPS protection)
 * Prevents abuse on resource-constrained servers
 */
const userLorebookRequests = new Map();
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX_REQUESTS = 30; // 30 requests per minute per user

export function rateLimitLorebooks(req, res, next) {
    const userHandle = req.user?.handle || 'anonymous';
    const now = Date.now();
    
    if (!userLorebookRequests.has(userHandle)) {
        userLorebookRequests.set(userHandle, []);
    }
    
    const requests = userLorebookRequests.get(userHandle);
    
    // Remove requests outside the time window
    const validRequests = requests.filter(time => now - time < RATE_LIMIT_WINDOW);
    
    if (validRequests.length >= RATE_LIMIT_MAX_REQUESTS) {
        console.warn(`[Security] Rate limit exceeded for user: ${userHandle}`);
        return res.status(429).json({ 
            error: 'Too many requests. Please try again later.',
            retryAfter: 60 
        });
    }
    
    validRequests.push(now);
    userLorebookRequests.set(userHandle, validRequests);
    
    next();
}

// Clean up old rate limit data every 5 minutes
setInterval(() => {
    const now = Date.now();
    for (const [user, requests] of userLorebookRequests.entries()) {
        const validRequests = requests.filter(time => now - time < RATE_LIMIT_WINDOW);
        if (validRequests.length === 0) {
            userLorebookRequests.delete(user);
        } else {
            userLorebookRequests.set(user, validRequests);
        }
    }
}, 5 * 60 * 1000);
