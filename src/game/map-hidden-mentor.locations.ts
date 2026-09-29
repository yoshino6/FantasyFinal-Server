/** 仅服务器使用：隐藏导师不写入 map_npcs、地图标记或普通附近目标。 */
export const mapHiddenMentorLocations = [
  { professionCode: 'sword_shadow', mentorCode: 'mentor_shadow_sword', regionCode: 'dark_forest_deep', x: -207, y: -272, z: 0, minimumRange: 4, hint: '树影之间有脚步，却没有落叶声。' },
  { professionCode: 'titan', mentorCode: 'mentor_titan', regionCode: 'ridge_foothills', x: -337, y: 137, z: 0, minimumRange: 4, hint: '石壁把你的呼吸声慢慢推了回来。' },
  { professionCode: 'spirit_summoner', mentorCode: 'mentor_summoner_mia', regionCode: 'mistalgae_marsh', x: 333, y: -137, z: 0, minimumRange: 4, hint: '三种不同的回声在水面下同时回应。' },
  { professionCode: 'master_thief', mentorCode: 'mentor_master_thief', regionCode: 'gravelwind_shore', x: -199, y: 133, z: 0, minimumRange: 4, hint: '潮声里夹着金属碰撞，却找不到来源。' },
  { professionCode: 'holy_knight', mentorCode: 'mentor_holy_knight', regionCode: 'frostcrown_plateau', x: -207, y: 382, z: 0, minimumRange: 5, hint: '风雪没有吹灭那一点仍在守望的灯。' },
  { professionCode: 'stringblade', mentorCode: 'mentor_stringblade', regionCode: 'thundercliff', x: 337, y: 369, z: 0, minimumRange: 5, hint: '弓弦声从近处来，箭痕却留在远处。' }
] as const;

export type MapHiddenMentorLocation = typeof mapHiddenMentorLocations[number];
