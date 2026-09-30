/**
 * Visual Indicator Content Script
 *
 * Shows a pulsing red glow border and stop button when browser automation
 * is active. Automatically hides during screenshots and restores after.
 *
 * Messages handled:
 * - show_indicator: Display the pulsing border overlay and stop button
 * - hide_indicator: Remove all visual indicators
 * - pre_screenshot: Hide indicators temporarily (responds with wasVisible)
 * - post_screenshot: Restore indicators if they were visible before
 *
 * CSS isolation: Uses unique IDs and inline styles to avoid conflicts
 * with page content.
 *
 * Input handling: the indicator is purely visual and MUST NOT intercept
 * input. It previously installed capture-phase blockers on window for
 * click/keydown/mousedown/etc. that called stopImmediatePropagation(), and
 * gave the full-viewport border `pointer-events: auto`.
 *
 * That blocked the automation itself. Events synthesized by CDP
 * (Input.dispatchMouseEvent / Input.dispatchKeyEvent) arrive with
 * isTrusted === true and are indistinguishable from human input, so a
 * blanket blocker cannot block the user without also blocking the agent.
 * Observed symptoms: `key` reported success but delivered nothing (no
 * keydown ever reached the focused input, so forms could not be submitted),
 * and `click` only moved focus when it raced ahead of the overlay mount.
 *
 * Escape remains wired to stop automation, but is no longer swallowed.
 */

// --- State ---

let overlayElement: HTMLElement | null = null;
let stopButtonElement: HTMLElement | null = null;
let styleElement: HTMLStyleElement | null = null;
let inputBlockersInstalled = false;

// --- Unique IDs to avoid CSS conflicts ---

const OVERLAY_ID = '__chromeuse_visual_indicator_overlay__';
const STOP_BUTTON_ID = '__chromeuse_visual_indicator_stop__';
const STYLE_ID = '__chromeuse_visual_indicator_style__';
const ANIMATION_NAME = '__chromeuse_pulse__';

/**
 * Only keydown is observed, and only to honour Escape as the stop hotkey.
 * Mouse and other keyboard events are deliberately NOT intercepted: CDP
 * input is indistinguishable from user input, so blocking the user also
 * blocks the agent.
 */
export const OBSERVED_INPUT_EVENTS = ['keydown'] as const;

const BLOCKER_OPTIONS = { capture: true, passive: false } as const;

/**
 * Style for the full-viewport pulsing border.
 *
 * Exported so the click-through invariant is testable: this element spans the
 * entire viewport at the maximum z-index, so `pointer-events: none` is load
 * bearing, not cosmetic.
 */
export const OVERLAY_STYLE_DECLARATIONS = [
  'position: fixed',
  'top: 0',
  'left: 0',
  'right: 0',
  'bottom: 0',
  'pointer-events: none',
  'z-index: 2147483647',
  'border: 3px solid rgba(239, 68, 68, 0.8)',
  'box-shadow: inset 0 0 22px rgba(239, 68, 68, 0.18)',
  `animation: ${ANIMATION_NAME} 2s ease-in-out infinite`,
  'box-sizing: border-box',
] as const;

function stopAutomation(): void {
  chrome.runtime.sendMessage({ action: 'stop_automation' });
  hideIndicator();
}

/**
 * Handle Escape as the automation stop hotkey.
 *
 * Every other event is passed through untouched. Swallowing them broke the
 * agent's own CDP-dispatched input (see the file header).
 */
function handleStopHotkey(event: Event): void {
  if (
    event instanceof KeyboardEvent &&
    event.type === 'keydown' &&
    event.key === 'Escape'
  ) {
    event.preventDefault();
    event.stopImmediatePropagation();
    stopAutomation();
  }
}

function installInputBlockers(): void {
  if (inputBlockersInstalled) return;
  inputBlockersInstalled = true;
  for (const eventName of OBSERVED_INPUT_EVENTS) {
    window.addEventListener(eventName, handleStopHotkey, BLOCKER_OPTIONS);
  }
}

function removeInputBlockers(): void {
  if (!inputBlockersInstalled) return;
  inputBlockersInstalled = false;
  for (const eventName of OBSERVED_INPUT_EVENTS) {
    window.removeEventListener(eventName, handleStopHotkey, BLOCKER_OPTIONS);
  }
}

// --- Show / Hide ---

function showIndicator(): void {
  if (overlayElement) return; // Already visible

  installInputBlockers();

  // Inject keyframe animation stylesheet
  styleElement = document.createElement('style');
  styleElement.id = STYLE_ID;
  styleElement.textContent = `
    @keyframes ${ANIMATION_NAME} {
      0%, 100% {
        border-color: rgba(239, 68, 68, 0.8);
        box-shadow: inset 0 0 22px rgba(239, 68, 68, 0.18);
      }
      50% {
        border-color: rgba(239, 68, 68, 0.45);
        box-shadow: inset 0 0 12px rgba(239, 68, 68, 0.08);
      }
    }
  `;
  (document.head ?? document.documentElement).appendChild(styleElement);

  // Create pulsing border overlay
  overlayElement = document.createElement('div');
  overlayElement.id = OVERLAY_ID;
  overlayElement.style.cssText = OVERLAY_STYLE_DECLARATIONS.join('; ');

  // Create stop button (top-right corner)
  stopButtonElement = document.createElement('div');
  stopButtonElement.id = STOP_BUTTON_ID;
  stopButtonElement.textContent = '\u25A0 Stop (Esc)';
  stopButtonElement.style.cssText = [
    'position: fixed',
    'top: 8px',
    'right: 8px',
    'background: #ef4444',
    'color: white',
    'padding: 4px 12px',
    'border-radius: 6px',
    'font: 12px/1.5 system-ui, -apple-system, sans-serif',
    'cursor: default',
    'pointer-events: none',
    'z-index: 2147483647',
    'box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3)',
    'user-select: none',
    'transition: background 0.15s ease',
  ].join('; ');

  // Append to document body (or documentElement if body not yet available)
  const parent = document.body ?? document.documentElement;
  parent.appendChild(overlayElement);
  parent.appendChild(stopButtonElement);
}

function hideIndicator(): void {
  overlayElement?.remove();
  stopButtonElement?.remove();
  styleElement?.remove();
  removeInputBlockers();
  overlayElement = null;
  stopButtonElement = null;
  styleElement = null;
}

// --- Message Listener ---

chrome.runtime.onMessage.addListener(
  (
    message: { action: string; wasVisible?: boolean },
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response?: unknown) => void,
  ) => {
    switch (message.action) {
      case 'show_indicator':
        showIndicator();
        sendResponse({ success: true });
        break;

      case 'hide_indicator':
        hideIndicator();
        sendResponse({ success: true });
        break;

      case 'pre_screenshot': {
        // Hide indicators during screenshot capture, report whether they were visible
        const wasVisible = overlayElement !== null;
        hideIndicator();
        sendResponse({ wasVisible });
        break;
      }

      case 'post_screenshot':
        // Restore indicators if they were visible before the screenshot
        if (message.wasVisible) {
          showIndicator();
        }
        sendResponse({ success: true });
        break;

      default:
        // Unknown action - ignore, don't send response
        return;
    }

    // Return true to indicate we called sendResponse synchronously
    // (all our handlers are synchronous DOM operations)
  },
);
