import type { StatusColor, StatusEffect, StatusObject } from "../../shared/schema";

interface DefaultStatus {
  name: string;
  effect?: StatusEffect;
  color: StatusColor;
}

const PEOPLE: DefaultStatus[] = [
  { name: "New", color: "ocean" },
  { name: "Active", color: "teal" },
  { name: "Prospecting", color: "sage" },
  { name: "Not Interested", effect: "ends_sequence", color: "neutral" },
  { name: "Do Not Contact", effect: "do_not_contact", color: "rose" },
];

/**
 * The statuses a new organization starts with. The first in each list is the
 * default for new records. Migration 0003 gives existing organizations the
 * same set; keep the two in step.
 */
export const DEFAULT_STATUSES: Record<StatusObject, DefaultStatus[]> = {
  leads: PEOPLE,
  contacts: PEOPLE,
  accounts: [
    { name: "Active", color: "teal" },
    { name: "Customer", color: "teal" },
    { name: "Vendor", color: "neutral" },
    { name: "Partner", color: "sage" },
    { name: "Inactive", color: "neutral" },
    { name: "Do Not Contact", color: "rose" },
  ],
  opportunities: [
    { name: "Prospecting", color: "ocean" },
    { name: "Qualified", color: "sage" },
    { name: "Proposal", color: "teal" },
    { name: "Negotiation", color: "mauve" },
    { name: "Closed Won", effect: "won", color: "teal" },
    { name: "Closed Lost", effect: "lost", color: "neutral" },
  ],
};
