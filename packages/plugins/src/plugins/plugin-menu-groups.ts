/**
 * Grouping for the host's Plugins menu.
 *
 * The point of this module is to keep the host generic. `PluginsMenu` renders
 * one submenu per entry below, placed where the group's first member would have
 * appeared, so adding a plugin to a group — or adding a whole group — is a change
 * *here*, in a file this project owns, and not in the upstream menu component.
 * That matters because the menu component is upstream code we want to keep
 * mergeable: the fewer edits it carries, the less there is to reconcile when the
 * upstream app is updated.
 *
 * The label is an i18n key resolved by the host, since this package cannot call
 * `t()`.
 */

import { GEOIM3D_OBJECTS_PLUGIN_ID } from "./geoim3d-objects";
import { KMA_PLUGIN_ID } from "./maplibre-kma";
import { VWORLD_PLUGIN_ID } from "./maplibre-vworld";

export interface PluginMenuGroup {
  /** Stable id, used as the submenu's React key. */
  id: string;
  /** i18n key for the submenu label, resolved by the host. */
  labelKey: string;
  /** Plugin ids in this group, in the order they should be listed. */
  pluginIds: readonly string[];
}

export const PLUGIN_MENU_GROUPS: readonly PluginMenuGroup[] = [
  {
    id: "geoim3d",
    labelKey: "toolbar.item.geoim3dServices",
    // geoIM3D's own integrations. Each registers its own toolbar menu when
    // activated, so this submenu is only the on/off switch.
    pluginIds: [VWORLD_PLUGIN_ID, KMA_PLUGIN_ID, GEOIM3D_OBJECTS_PLUGIN_ID],
  },
];

const GROUP_BY_PLUGIN_ID = new Map<string, PluginMenuGroup>(
  PLUGIN_MENU_GROUPS.flatMap((group) => group.pluginIds.map((id) => [id, group] as const)),
);

/**
 * The group a plugin belongs to, if any.
 *
 * @param pluginId - The plugin id.
 * @returns The group, or undefined when the plugin is not grouped.
 */
export function pluginMenuGroupFor(pluginId: string): PluginMenuGroup | undefined {
  return GROUP_BY_PLUGIN_ID.get(pluginId);
}
