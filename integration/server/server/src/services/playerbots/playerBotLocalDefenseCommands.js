"use strict";
function handle(argument, isStaff) {
  if (!isStaff)
    return "Administrator access is required to inspect or configure local defense.";
  const config = require("./playerBotLocalDefenseConfig");
  const adapter = require("./playerBotLocalDefenseAdapter");
  const text = String(argument || "status").trim();
  try {
    if (text === "off" || text.startsWith("set ")) {
      const patch =
        text === "off"
          ? { enabled: false, aggressive: false }
          : JSON.parse(text.slice(4));
      if (!patch || typeof patch !== "object" || Array.isArray(patch))
        throw new Error("Configuration must be a JSON object");
      config.set({ ...config.get(), ...patch });
      adapter.maintain();
      for (const id of Object.keys(adapter.snapshot().leases)) {
        require("./playerBotAutonomyRuntime")
          .wakeIndustryCycleStep(Number(id), { immediate: true })
          .catch((error) =>
            require("../../utils/logger").warn(
              `[LocalDefense] Config wake failed: ${error.message}`,
            ),
          );
      }
      return `Local defense configuration saved. Disabling requests orderly disengagement; ships may still be at risk.\n${JSON.stringify(config.get())}`;
    }
    const cancelled = text.match(/^cancel\s+(LD\d+)$/);
    if (cancelled)
      return adapter.cancelIncident(cancelled[1])
        ? `Incident ${cancelled[1]} is closing; responders will recall drones and release their reservations.`
        : "Incident not found or already closing.";
    if (text === "status") {
      const settings = config.get();
      return `Local defense: ${settings.enabled ? "enabled" : "disabled"}; active reservations: ${Object.keys(adapter.snapshot().leases).length}\n${JSON.stringify(settings)}`;
    }
    if (text === "events") {
      return (
        Object.values(adapter.snapshot().events)
          .sort((a, b) => b.lastThreatAt - a.lastThreatAt)
          .slice(0, 10)
          .map(
            (event) =>
              `${event.id}: ${event.status}; system ${event.systemID}; attacker ${event.attackerID}; victims ${Object.keys(event.victims).join(",")}; reason ${event.reason || event.history.at(-1)?.reason || "see history"}`,
          )
          .join("\n") || "No local defense incidents."
      );
    }
    return "Usage: /playerbots defense status | events | off | cancel LD_ID | set {JSON configuration patch}";
  } catch (error) {
    return `Local defense command failed: ${error.message}`;
  }
}
module.exports = { handle };
