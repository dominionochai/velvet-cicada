import type { Category, OptionGroup, TryOnOption } from "./types";
import { slotKey } from "./types";

const opt = (id: string, label: string, color: string, params?: TryOnOption["params"]): TryOnOption => ({
  id, label, color, params,
});

export const CATALOG: Category[] = [
  {
    id: "makeup",
    label: "Makeup",
    groups: [
      {
        id: "lips", label: "Lips", adjustable: true,
        options: [opt("lip-ruby", "Ruby", "#B3123C"), opt("lip-nude", "Nude", "#C98F7E"), opt("lip-berry", "Berry", "#7A1F4B")],
      },
      {
        id: "eyes", label: "Eyes", adjustable: true,
        options: [opt("eye-smoky", "Smoky", "#2B2B33"), opt("eye-gold", "Gold shimmer", "#D4A537")],
      },
      {
        id: "blush", label: "Blush", adjustable: true,
        options: [opt("blush-peach", "Peach", "#F4A58A"), opt("blush-rose", "Rose", "#E57A94")],
      },
    ],
  },
  {
    id: "hair",
    label: "Hair",
    groups: [
      {
        id: "color", label: "Color", adjustable: true,
        options: [
          opt("hair-auburn", "Auburn Red", "#8B2E1F"),
          opt("hair-platinum", "Platinum Blonde", "#E6E1D3"),
          opt("hair-rosegold", "Rose Gold", "#C98B7B"),
          opt("hair-teal", "Teal Blue", "#1F7A8C"),
          opt("hair-jet", "Jet Black", "#111114"),
        ],
      },
    ],
  },
  {
    id: "fashion",
    label: "Fashion",
    groups: [
      {
        id: "outerwear", label: "Outerwear", adjustable: false,
        options: [opt("jacket-formal", "Formal Jacket", "#23283B"), opt("jacket-denim", "Denim Jacket", "#3E6593"), opt("scarf-silk", "Silk Scarf", "#B0413E")],
      },
    ],
  },
  {
    id: "accessories",
    label: "Accessories",
    groups: [
      {
        id: "eyewear", label: "Eyewear", adjustable: false,
        options: [opt("glasses-gold", "Gold Frames", "#C9A227"), opt("glasses-black", "Black Round", "#141414"), opt("glasses-clear", "Clear Aviator", "#A9C7D6")],
      },
      {
        id: "earrings", label: "Earrings", adjustable: false,
        options: [opt("ear-pearl", "Pearl Studs", "#F3EFE6"), opt("ear-hoops", "Gold Hoops", "#C9A227")],
      },
    ],
  },
];

export const DEFAULT_INTENSITY = 50;

export function findCategory(id: string): Category | undefined {
  return CATALOG.find((category) => category.id === id);
}

export function findGroup(categoryId: string, groupId: string): OptionGroup | undefined {
  return findCategory(categoryId)?.groups.find((group) => group.id === groupId);
}

export function findOption(categoryId: string, groupId: string, optionId: string): TryOnOption | undefined {
  return findGroup(categoryId, groupId)?.options.find((option) => option.id === optionId);
}

/** Resolves a slot key like "hair/color" back to its category and group ids. */
export function parseSlot(key: string): { categoryId: string; groupId: string } {
  const [categoryId, groupId] = key.split("/");
  return { categoryId, groupId };
}

export { slotKey };
