import type { StatusColor, StatusEffect, StatusObject } from "../../shared/schema";

interface DefaultStatus {
  name: string;
  effect?: StatusEffect;
  color: StatusColor;
  /** Opportunity stages only. Migration 0004 sets the same numbers for existing organizations. */
  probability?: number;
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
    { name: "Prospecting", color: "ocean", probability: 10 },
    { name: "Qualified", color: "sage", probability: 25 },
    { name: "Proposal", color: "teal", probability: 50 },
    { name: "Negotiation", color: "mauve", probability: 75 },
    { name: "Closed Won", effect: "won", color: "teal", probability: 100 },
    { name: "Closed Lost", effect: "lost", color: "neutral", probability: 0 },
  ],
};
