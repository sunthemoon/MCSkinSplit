export const SEMANTIC_CATEGORIES = [
  "skin",
  "face",
  "eye",
  "mouth",
  "face_detail",
  "hair",
  "head_accessory",
  "face_accessory",
  "upper_clothing",
  "lower_clothing",
  "one_piece_clothing",
  "sleeve",
  "glove",
  "legwear",
  "shoe",
  "neck_accessory",
  "body_accessory",
  "waist_accessory",
  "arm_accessory",
  "leg_accessory",
  "back_accessory",
  "other_accessory",
  "unknown",
] as const;

export type SemanticCategory = (typeof SEMANTIC_CATEGORIES)[number];

/**
 * Coarse reusable-asset groups are an orthogonal browsing/composition aid.
 * They deliberately do not replace the precise semantic taxonomy above.
 */
export const AGGREGATE_KINDS = ["hair", "clothing", "accessory"] as const;

export type AggregateKind = (typeof AGGREGATE_KINDS)[number];

const AGGREGATE_CATEGORIES: Readonly<
  Record<AggregateKind, readonly SemanticCategory[]>
> = {
  hair: ["hair"],
  clothing: [
    "upper_clothing",
    "lower_clothing",
    "one_piece_clothing",
    "sleeve",
    "glove",
    "legwear",
    "shoe",
  ],
  accessory: [
    "head_accessory",
    "face_accessory",
    "neck_accessory",
    "body_accessory",
    "waist_accessory",
    "arm_accessory",
    "leg_accessory",
    "back_accessory",
    "other_accessory",
  ],
};

export function isAggregateKind(value: unknown): value is AggregateKind {
  return AGGREGATE_KINDS.includes(value as AggregateKind);
}

export function aggregateKindForCategory(
  category: SemanticCategory,
): AggregateKind | null {
  for (const kind of AGGREGATE_KINDS) {
    if (AGGREGATE_CATEGORIES[kind].includes(category)) return kind;
  }
  return null;
}

export function categoryBelongsToAggregate(
  category: SemanticCategory,
  kind: AggregateKind,
): boolean {
  return AGGREGATE_CATEGORIES[kind].includes(category);
}

export const SEMANTIC_CATEGORY_LABELS: Readonly<
  Record<SemanticCategory, string>
> = {
  skin: "肤色",
  face: "面部",
  eye: "眼睛",
  mouth: "嘴部",
  face_detail: "面部细节",
  hair: "头发",
  head_accessory: "头部饰品",
  face_accessory: "面部饰品",
  upper_clothing: "上装",
  lower_clothing: "下装",
  one_piece_clothing: "连体服装",
  sleeve: "袖子",
  glove: "手套",
  legwear: "腿部服饰",
  shoe: "鞋",
  neck_accessory: "颈部饰品",
  body_accessory: "身体饰品",
  waist_accessory: "腰部饰品",
  arm_accessory: "手臂饰品",
  leg_accessory: "腿部饰品",
  back_accessory: "背部饰品",
  other_accessory: "其他饰品",
  unknown: "待分类",
};

export function isSemanticCategory(value: unknown): value is SemanticCategory {
  return SEMANTIC_CATEGORIES.includes(value as SemanticCategory);
}
