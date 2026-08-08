/**
 * Menu category structure — normalize, order, guest tabs.
 */
export const ALL_CATEGORY_ID = 'all';

export function ensureAllCategory(categories = []) {
  const list = Array.isArray(categories) ? [...categories] : [];
  const rest = list.filter((c) => c && c.id && c.id !== ALL_CATEGORY_ID);
  return [{ id: ALL_CATEGORY_ID, label: 'すべて', icon: '🍽️' }, ...rest];
}

export function slugCategoryId(label, existingIds = new Set()) {
  const raw = String(label || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^\w\u3040-\u30ff\u4e00-\u9faf-]/g, '');
  let base = raw || `cat_${Date.now().toString(36).slice(2, 8)}`;
  let id = base;
  let n = 2;
  while (existingIds.has(id)) {
    id = `${base}_${n}`;
    n += 1;
  }
  return id;
}

export function normalizeCategories(categories) {
  const raw = Array.isArray(categories) ? categories : [];
  const withoutAll = raw.filter((c) => c && c.id && c.id !== ALL_CATEGORY_ID);
  const seen = new Set();
  const cleaned = [];
  for (const c of withoutAll) {
    const id = String(c.id).trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    cleaned.push({
      id,
      label: String(c.label || id).trim() || id,
      icon: String(c.icon || '').trim() || '🍽️',
      hidden: !!c.hidden,
      order: typeof c.order === 'number' ? c.order : cleaned.length,
    });
  }
  cleaned.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  cleaned.forEach((c, i) => {
    c.order = i;
  });
  return ensureAllCategory(cleaned);
}

export function guestCategoryTabs(menu) {
  const categories = normalizeCategories(menu?.categories);
  return categories.filter((c) => {
    if (c.id === ALL_CATEGORY_ID) return true;
    if (c.hidden) return false;
    return true;
  });
}

export function reconcileMenuCategories(menu) {
  if (!menu) return menu;
  const categories = normalizeCategories(menu.categories);
  const valid = new Set(categories.filter((c) => c.id !== ALL_CATEGORY_ID).map((c) => c.id));
  const fallback = categories.find((c) => c.id !== ALL_CATEGORY_ID)?.id || 'side';
  const items = (menu.items || []).map((item) => {
    if (!valid.has(item.category)) {
      return { ...item, category: fallback };
    }
    return item;
  });
  return { ...menu, categories, items };
}

export function defaultCategoryId(menu) {
  const cats = normalizeCategories(menu?.categories).filter((c) => c.id !== ALL_CATEGORY_ID && !c.hidden);
  return cats[0]?.id || 'side';
}
