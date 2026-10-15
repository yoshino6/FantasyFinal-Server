/** 打造装备的主属性由装备类型决定。 */
export const forgePrimaryKeys = (category: string, subtype: string | null | undefined): string[] => {
  if (category === '武器' || category === '副手') {
    if (subtype === '盾牌') return ['physicalDefense', 'magicDefense'];
    if (subtype === '长剑') return ['physicalAttack'];
    if (subtype === '法杖' || subtype === '法书' || subtype === '法球') return ['magicAttack'];
    if (subtype === '匕首') return ['physicalAttack', 'magicAttack'];
    return ['physicalAttack'];
  }
  // 五种甲的双防均为主属性且基准相同，甲类差异由附带属性和套装提供。
  return ['physicalDefense', 'magicDefense'];
};
