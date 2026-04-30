/**
 * form_input tool — set values on form elements by ref ID.
 *
 * Uses the content script's ref system to find elements by ref (ref_N)
 * and sets their values. Supports text inputs, textareas, selects,
 * checkboxes, radio buttons, and contenteditable elements.
 *
 * Dispatches proper DOM events (input, change) so that framework bindings
 * (React, Vue, etc.) are notified via native property setters.
 *
 * Args:
 *   tabId (number, required): The tab containing the form element.
 *   ref   (string, required): Element ref from read_page (e.g. "ref_5").
 *   value (string, required): Value to set. For checkboxes/radios use "true"/"false".
 */

import type {
  ToolHandler,
  ToolResult,
  ToolContext,
} from "../../types/messages.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Response shape from the content script's set_form_value action */
interface SetValueResponse {
  success: boolean;
  error?: string;
  tagName?: string;
  type?: string;
  previousValue?: string;
  newValue?: string;
}

// ---------------------------------------------------------------------------
// Tool handler
// ---------------------------------------------------------------------------

export class FormInputTool implements ToolHandler {
  async execute(
    args: Record<string, unknown>,
    _context: ToolContext,
  ): Promise<ToolResult> {
    try {
      // --- Validate args ---
      const tabId = typeof args.tabId === "number" ? args.tabId : undefined;
      if (tabId === undefined) {
        return {
          success: false,
          content: [
            { type: "text", text: "Missing required argument: tabId (number)" },
          ],
        };
      }

      const ref = typeof args.ref === "string" ? args.ref.trim() : "";
      if (!ref) {
        return {
          success: false,
          content: [
            {
              type: "text",
              text: 'Missing required argument: ref (string, e.g. "ref_5")',
            },
          ],
        };
      }

      const value = typeof args.value === "string" ? args.value : undefined;
      if (value === undefined) {
        return {
          success: false,
          content: [
            { type: "text", text: "Missing required argument: value (string)" },
          ],
        };
      }

      // --- Verify tab exists ---
      try {
        await chrome.tabs.get(tabId);
      } catch {
        return {
          success: false,
          content: [{ type: "text", text: `Tab ${tabId} not found` }],
        };
      }

      // --- Try content script message first ---
      try {
        const response = (await chrome.tabs.sendMessage(tabId, {
          action: "set_form_value",
          ref,
          value,
        })) as SetValueResponse | undefined;

        if (response?.success) {
          return {
            success: true,
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    ref,
                    tagName: response.tagName,
                    type: response.type,
                    previousValue: response.previousValue,
                    newValue: response.newValue,
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }

        if (response?.error) {
          return {
            success: false,
            content: [{ type: "text", text: response.error }],
          };
        }
      } catch {
        // Content script not loaded — try injection fallback
      }

      // --- Fallback: inject scripting ---
      return this.setValueViaScripting(tabId, ref, value);
    } catch (error) {
      return {
        success: false,
        content: [
          {
            type: "text",
            text: `form_input failed: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Fallback: inject a function that finds the element by ref and sets its
   * value. Works even if the content script message handler is unavailable.
   * Uses native property setters for React/Vue compatibility.
   */
  private async setValueViaScripting(
    tabId: number,
    ref: string,
    value: string,
  ): Promise<ToolResult> {
    try {
      // Ensure content script is loaded (for ref assignments)
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          files: ["dist/content-scripts/accessibilityTree.js"],
        });
        await new Promise((resolve) => setTimeout(resolve, 50));
      } catch {
        // May already be loaded
      }

      const [result] = await chrome.scripting.executeScript({
        target: { tabId },
        func: (targetRef: string, targetValue: string) => {
          const REF_PROP = "__opencode_ref";

          function findByRef(root: Element, r: string): Element | null {
            const walker = document.createTreeWalker(
              root,
              NodeFilter.SHOW_ELEMENT,
              null,
            );
            let node: Node | null = walker.currentNode;
            while (node) {
              if (
                node instanceof Element &&
                (node as unknown as Record<string, string>)[REF_PROP] === r
              ) {
                return node;
              }
              node = walker.nextNode();
            }
            return null;
          }

          const el = findByRef(document.body, targetRef);
          if (!el) {
            return {
              success: false,
              error: `Element not found for ref: ${targetRef}`,
            };
          }

          const tagName = el.tagName.toLowerCase();
          let previousValue = "";

          // --- HTMLInputElement ---
          if (el instanceof HTMLInputElement) {
            if (el.type === "checkbox" || el.type === "radio") {
              previousValue = String(el.checked);
              el.checked =
                targetValue === "true" || targetValue === "1";
              el.dispatchEvent(new Event("change", { bubbles: true }));
              el.dispatchEvent(new Event("input", { bubbles: true }));
              return {
                success: true,
                tagName,
                type: el.type,
                previousValue,
                newValue: String(el.checked),
              };
            }

            previousValue = el.value;

            // Native setter triggers React/Vue bindings
            const nativeSetter = Object.getOwnPropertyDescriptor(
              HTMLInputElement.prototype,
              "value",
            )?.set;
            if (nativeSetter) {
              nativeSetter.call(el, targetValue);
            } else {
              el.value = targetValue;
            }

            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));

            return {
              success: true,
              tagName,
              type: el.type,
              previousValue,
              newValue: el.value,
            };
          }

          // --- HTMLTextAreaElement ---
          if (el instanceof HTMLTextAreaElement) {
            previousValue = el.value;

            const nativeSetter = Object.getOwnPropertyDescriptor(
              HTMLTextAreaElement.prototype,
              "value",
            )?.set;
            if (nativeSetter) {
              nativeSetter.call(el, targetValue);
            } else {
              el.value = targetValue;
            }

            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));

            return {
              success: true,
              tagName,
              type: "textarea",
              previousValue,
              newValue: el.value,
            };
          }

          // --- HTMLSelectElement ---
          if (el instanceof HTMLSelectElement) {
            previousValue = el.value;

            let matched = false;
            // Try exact match by value or text
            for (let i = 0; i < el.options.length; i++) {
              const opt = el.options[i];
              if (opt.value === targetValue || opt.text === targetValue) {
                el.selectedIndex = i;
                matched = true;
                break;
              }
            }

            // Try case-insensitive match
            if (!matched) {
              const lowerValue = targetValue.toLowerCase();
              for (let i = 0; i < el.options.length; i++) {
                const opt = el.options[i];
                if (
                  opt.value.toLowerCase() === lowerValue ||
                  opt.text.toLowerCase() === lowerValue
                ) {
                  el.selectedIndex = i;
                  matched = true;
                  break;
                }
              }
            }

            if (!matched) {
              return {
                success: false,
                error: `No option matching "${targetValue}" found in select element`,
              };
            }

            el.dispatchEvent(new Event("change", { bubbles: true }));
            el.dispatchEvent(new Event("input", { bubbles: true }));

            return {
              success: true,
              tagName,
              type: "select",
              previousValue,
              newValue: el.value,
            };
          }

          // --- Contenteditable ---
          if (el instanceof HTMLElement && el.isContentEditable) {
            previousValue = el.innerText;
            el.innerText = targetValue;
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));

            return {
              success: true,
              tagName,
              type: "contenteditable",
              previousValue,
              newValue: el.innerText,
            };
          }

          return {
            success: false,
            error: `Element <${tagName}> (ref: ${targetRef}) is not a supported form element`,
          };
        },
        args: [ref, value],
      });

      const response = result?.result as SetValueResponse | null;

      if (!response) {
        return {
          success: false,
          content: [
            { type: "text", text: "Failed to execute form input script" },
          ],
        };
      }

      if (!response.success) {
        return {
          success: false,
          content: [
            {
              type: "text",
              text: response.error ?? "Unknown error setting form value",
            },
          ],
        };
      }

      return {
        success: true,
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                ref,
                tagName: response.tagName,
                type: response.type,
                previousValue: response.previousValue,
                newValue: response.newValue,
              },
              null,
              2,
            ),
          },
        ],
      };
    } catch (error) {
      return {
        success: false,
        content: [
          {
            type: "text",
            text: `form_input scripting fallback failed: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
}
