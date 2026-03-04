/**
 * PM2 Ecosystem Configuration for DreamTavern
 * Optimized for Dreamhost VPS: 2GB RAM, 2 CPU cores, 5 users
 * 
 * Installation:
 * 1. Save this file as: ecosystem.config.js (in your SillyTavern root directory)
 * 2. Run: pm2 start ecosystem.config.js
 * 3. Save for auto-start: pm2 save
 * 4. Enable startup: pm2 startup (follow the instructions it gives you)
 * 
 * Useful commands:
 * - pm2 status           - Check if running
 * - pm2 logs dreamtavern - View logs
 * - pm2 restart dreamtavern - Restart server
 * - pm2 stop dreamtavern - Stop server
 * - pm2 monit            - Monitor CPU/RAM usage
 */

module.exports = {
    apps: [{
        // Application name
        name: 'dreamtavern',
        
        // Entry point
        script: './server.js',
        
        // Arguments (customize these for your setup)
        args: '',
        
        // Working directory
        cwd: './',
        
        // ====================================================================
        // PERFORMANCE SETTINGS (optimized for 2GB RAM)
        // ====================================================================
        
        // Number of instances (1 for 2GB RAM with 5 users)
        // Don't use cluster mode with only 2GB RAM - wastes memory
        instances: 1,
        
        // Execution mode
        exec_mode: 'fork', // Not 'cluster' - saves RAM
        
        // Maximum memory before auto-restart (800MB)
        // Leaves ~1.2GB for system + other processes
        max_memory_restart: '800M',
        
        // Node.js arguments to reduce memory usage
        node_args: [
            '--max-old-space-size=768',  // Limit heap to 768MB
            '--optimize-for-size',        // Optimize for memory, not speed
        ],
        
        // ====================================================================
        // AUTO-RESTART SETTINGS
        // ====================================================================
        
        // Auto-restart if app crashes
        autorestart: true,
        
        // Max restarts within min_uptime before considering app unstable
        max_restarts: 10,
        
        // Minimum uptime before considering restart (30 seconds)
        min_uptime: '30s',
        
        // Wait time before restart after crash (5 seconds)
        restart_delay: 5000,
        
        // Kill timeout (grace period before force kill)
        kill_timeout: 5000,
        
        // Listen for 'ready' event from app before considering it online
        wait_ready: false,
        
        // ====================================================================
        // LOGGING (with rotation to save disk space)
        // ====================================================================
        
        // Output log file
        out_file: './logs/dreamtavern-out.log',
        
        // Error log file  
        error_file: './logs/dreamtavern-error.log',
        
        // Combine out and error logs into single file
        combine_logs: true,
        
        // Merge cluster logs (not used in fork mode, but good to have)
        merge_logs: true,
        
        // Timestamp format for logs
        time: true,
        
        // Log date format
        log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
        
        // ====================================================================
        // ENVIRONMENT VARIABLES
        // ====================================================================
        
        env: {
            NODE_ENV: 'production',
            PORT: 8000, // Your DreamTavern port
        },
        
        // Development environment (use: pm2 start ecosystem.config.js --env development)
        env_development: {
            NODE_ENV: 'development',
            PORT: 8000,
        },
        
        // ====================================================================
        // MONITORING & HEALTH CHECKS
        // ====================================================================
        
        // CPU usage warning threshold (%)
        max_cpu_threshold: 80,
        
        // Enable PM2 monitoring (if using PM2 Plus)
        // pmx: true,
        
        // ====================================================================
        // DREAMHOST VPS SPECIFIC SETTINGS
        // ====================================================================
        
        // User to run as (change if needed)
        // user: 'your-username',
        
        // Auto-restart at specific times (e.g., daily at 4 AM)
        // Useful for clearing memory leaks
        cron_restart: '0 4 * * *', // Daily at 4 AM server time
        
        // Watch for file changes and auto-restart (DISABLE in production!)
        watch: false,
        
        // Ignore these directories if watch is enabled
        ignore_watch: [
            'node_modules',
            'logs',
            'data',
            '.git'
        ],
        
        // ====================================================================
        // GRACEFUL SHUTDOWN
        // ====================================================================
        
        // Send shutdown signal
        shutdown_with_message: true,
        
        // Listen for shutdown message
        listen_timeout: 10000,
    }],
    
    // ====================================================================
    // PM2 DEPLOYMENT CONFIGURATION (Optional - for git-based deploys)
    // ====================================================================
    
    deploy: {
        production: {
            // SSH key for deployment
            key: '~/.ssh/id_rsa',
            
            // User on remote server
            user: 'your-username',
            
            // Server address
            host: 'your-server.dreamhost.com',
            
            // Branch to deploy
            ref: 'origin/main',
            
            // Git repo
            repo: 'https://github.com/your-username/SillyTavern.git',
            
            // Path on server
            path: '/home/your-username/SillyTavern',
            
            // Post-deploy commands
            'post-deploy': 'npm install && pm2 reload ecosystem.config.js --env production',
            
            // Pre-deploy commands
            'pre-deploy-local': 'echo "Deploying to production..."'
        }
    }
};
