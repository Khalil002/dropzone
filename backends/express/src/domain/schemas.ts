import { z } from "zod";

export const credentialsSchema = z.object({
  email: z.string().trim().toLowerCase().regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, "must be an email address").max(254),
  password: z.string().min(8).max(72),
});

export const newDropSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(2000).default(""),
  priceCents: z.number().int().min(1),
  totalStock: z.number().int().min(1).max(1_000_000),
  startsAt: z.string().datetime({ offset: true }),
});

export const checkoutSchema = z.object({
  dropId: z.guid(),
  quantity: z.number().int().min(1).max(2),
});
