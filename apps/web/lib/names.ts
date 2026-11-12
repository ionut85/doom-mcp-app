// Friendly names for DOOM mobj types (vanilla info.h enum names). Freedoom
// replaces the art but keeps the same object types and behaviour.

const MONSTERS: Record<string, string> = {
  MT_POSSESSED: "zombieman",
  MT_SHOTGUY: "shotgun_guy",
  MT_VILE: "arch_vile",
  MT_UNDEAD: "revenant",
  MT_FATSO: "mancubus",
  MT_CHAINGUY: "chaingunner",
  MT_TROOP: "imp",
  MT_SERGEANT: "demon",
  MT_SHADOWS: "spectre",
  MT_HEAD: "cacodemon",
  MT_BRUISER: "baron_of_hell",
  MT_KNIGHT: "hell_knight",
  MT_SKULL: "lost_soul",
  MT_SPIDER: "spider_mastermind",
  MT_BABY: "arachnotron",
  MT_CYBORG: "cyberdemon",
  MT_PAIN: "pain_elemental",
  MT_WOLFSS: "ss_soldier",
};

const ITEMS: Record<string, string> = {
  MT_MISC0: "green_armor",
  MT_MISC1: "blue_armor",
  MT_MISC2: "health_bonus",
  MT_MISC3: "armor_bonus",
  MT_MISC4: "blue_keycard",
  MT_MISC5: "red_keycard",
  MT_MISC6: "yellow_keycard",
  MT_MISC7: "yellow_skull_key",
  MT_MISC8: "red_skull_key",
  MT_MISC9: "blue_skull_key",
  MT_MISC10: "stimpack",
  MT_MISC11: "medikit",
  MT_MISC12: "soulsphere",
  MT_INV: "invulnerability",
  MT_MISC13: "berserk",
  MT_INS: "invisibility",
  MT_MISC14: "radiation_suit",
  MT_MISC15: "computer_map",
  MT_MISC16: "light_amp_visor",
  MT_MEGA: "megasphere",
  MT_CLIP: "ammo_clip",
  MT_MISC17: "box_of_bullets",
  MT_MISC18: "rocket",
  MT_MISC19: "box_of_rockets",
  MT_MISC20: "energy_cell",
  MT_MISC21: "energy_cell_pack",
  MT_MISC22: "shells",
  MT_MISC23: "box_of_shells",
  MT_MISC24: "backpack",
  MT_MISC25: "bfg9000",
  MT_CHAINGUN: "chaingun",
  MT_MISC26: "chainsaw",
  MT_MISC27: "rocket_launcher",
  MT_MISC28: "plasma_rifle",
  MT_SHOTGUN: "shotgun",
  MT_SUPERSHOTGUN: "super_shotgun",
};

const OTHER: Record<string, string> = {
  MT_BARREL: "explosive_barrel",
};

export function friendlyName(type: string): string {
  return MONSTERS[type] ?? ITEMS[type] ?? OTHER[type] ?? type.replace(/^MT_/, "").toLowerCase();
}
