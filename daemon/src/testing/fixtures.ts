import type { V2Snapshot } from "@chromeuse/shared/v2";

/** A realistic snapshot in the shape produced by the jev-ultrafast snapshot.js port. */
export function flightsSnapshot(fingerprint = "fp-flights-1"): V2Snapshot {
  const from = { node: 11, role: "combobox", label: "Where from?", value: "Zürich" };
  const sort = { node: 12, role: "combobox", label: "Sort by", current_value: "Best" };
  return {
    url: "https://flights.example/search",
    title: "Flights",
    viewport: { w: 1280, h: 800 },
    scroll: { y: 0, height: 2400 },
    text: "Search flights\nWhere from?\nSort by",
    actions: [
      { id: "e1", kind: "fill", ...from },
      { id: "e2", kind: "click", ...from, label: "Open Where from?" },
      { id: "e3", kind: "click", node: 13, role: "button", label: "Search", value: "" },
      { id: "e4", kind: "select", ...sort, label: "Sort by → Price", value: "price" },
      { id: "e5", kind: "select", ...sort, label: "Sort by → Duration", value: "duration" },
      { id: "e6", kind: "select", ...sort, label: "Sort by → Departure time", value: "departure" },
      { id: "e7", kind: "click", node: 14, role: "checkbox", label: "Nonstop only", value: "on", checked: "true" },
      { id: "e8", kind: "click", node: 15, role: "checkbox", label: "Refundable", value: "on", checked: "false" },
      { id: "e9", kind: "click", node: 16, role: "button", label: "Passengers", value: "", expanded: "false" },
      { id: "scroll_down", kind: "scroll", label: "Scroll down" },
      { id: "wait", kind: "wait", label: "Wait for the page to update" },
    ],
    omitted_actions: 3,
    fingerprint,
  };
}
