import { getParsedUA, isMobile } from './RossAscends-mods.js';

const isFirefox = () => /firefox/i.test(navigator.userAgent);

function sanitizeInlineQuotationOnCopy() {
    // STRG+C, STRG+V on firefox leads to duplicate double quotes when inline quotation elements are copied.
    // To work around this, take the selection and transform <q> to <span> before calling toString().
    document.addEventListener('copy', function (event) {
        if (document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement) {
            return;
        }

        const selection = window.getSelection();
        if (!selection.anchorNode?.parentElement.closest('.mes_text')) {
            return;
        }

        const range = selection.getRangeAt(0).cloneContents();
        const tempDOM = document.createDocumentFragment();

        /**
         * Process a node, transforming <q> elements to <span> elements and preserving children.
         * @param {Node} node Input node
         * @returns {Node} Processed node
         */
        function processNode(node) {
            if (node.nodeType === Node.ELEMENT_NODE && node.nodeName.toLowerCase() === 'q') {
                // Transform <q> to <span>, preserve children
                const span = document.createElement('span');

                [...node.childNodes].forEach(child => {
                    const processedChild = processNode(child);
                    span.appendChild(processedChild);
                });

                return span;
            } else {
                // Nested structures containing <q> elements are unlikely
                return node.cloneNode(true);
            }
        }

        [...range.childNodes].forEach(child => {
            const processedChild = processNode(child);
            tempDOM.appendChild(processedChild);
        });

        const newRange = document.createRange();
        newRange.selectNodeContents(tempDOM);

        event.preventDefault();
        event.clipboardData.setData('text/plain', newRange.toString());
    });
}

function addSafariPatch() {
    const userAgent = getParsedUA();
    console.debug('User Agent', userAgent);
    const isMobileSafari = /iPad|iPhone|iPod/.test(navigator.platform) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const isDesktopSafari = userAgent?.browser?.name === 'Safari' && userAgent?.platform?.type === 'desktop';
    const isIOS = userAgent?.os?.name === 'iOS';

    if (isIOS || isMobileSafari || isDesktopSafari) {
        document.body.classList.add('safari');
    }

}

function addIOSDrawerTapFix() {
    // iOS Safari only synthesizes a click from a tap for elements that have
    // either cursor:pointer (set in ios-fixes.css) OR a direct non-delegated
    // click listener. The jQuery delegated handler on document is not enough.
    // Adding an empty direct listener is the proven, side-effect-free fix:
    // iOS sees the listener, marks the element as interactive, and synthesizes
    // the click — the jQuery delegated handler then fires as normal.
    const isIOS = /iP(hone|ad|od)/i.test(navigator.userAgent) ||
                  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    if (!isIOS) return;

    const holder = document.getElementById('top-settings-holder');
    if (!holder) return;

    const noop = function () {};

    // Apply to all toggles that already exist.
    holder.querySelectorAll('.drawer-toggle').forEach(el => {
        el.addEventListener('click', noop);
    });

    // Cover any toggles that might be injected after init (e.g. by extensions).
    holder.addEventListener('touchstart', function (e) {
        const toggle = e.target.closest('.drawer-toggle');
        if (toggle && !toggle._iosFixApplied) {
            toggle.addEventListener('click', noop);
            toggle._iosFixApplied = true;
        }
    }, { passive: true });
}

function applyBrowserFixes() {
    if (isFirefox()) {
        sanitizeInlineQuotationOnCopy();
    }

    if (isMobile()) {
        const fixFunkyPositioning = () => {
            // Skip the hack while an input/textarea is focused. Mobile keyboard
            // show/hide fires a 'resize' event; running the position:fixed hack
            // during keyboard toggle reflows the chat and causes scroll jumps.
            const active = document.activeElement;
            if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
                return;
            }
            console.debug('[Mobile] Device viewport change detected.');
            // Preserve chat scroll position across the position:fixed hack so
            // viewport-size changes (keyboard dismiss, etc.) don't bump the
            // user away from the message they were reading.
            const chat = document.getElementById('chat');
            const chatScroll = chat?.scrollTop ?? 0;
            document.documentElement.style.position = 'fixed';
            requestAnimationFrame(() => {
                document.documentElement.style.position = '';
                if (chat) chat.scrollTop = chatScroll;
            });
        };
        window.addEventListener('resize', fixFunkyPositioning);
        window.addEventListener('orientationchange', fixFunkyPositioning);
    }

    addSafariPatch();
    addIOSDrawerTapFix();
}

export { isFirefox, applyBrowserFixes };
