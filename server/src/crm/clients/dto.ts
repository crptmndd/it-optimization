import type { Client } from "@prisma/client";
import { z } from "zod";
import { optionalText, requiredTitle } from "../fields.js";

/**
 * Контакты — список, а не колонки: у одного клиента бывает три телефона и ни
 * одной почты. Тип свободной строкой, потому что «телеграм», «вотсап» и «сайт»
 * появляются и исчезают быстрее, чем стоит гонять миграции.
 */
const contact = z.object({
  type: z.string().trim().min(1).max(30),
  value: z.string().trim().min(1).max(200),
  label: optionalText(60).optional(),
});

const clientFields = {
  name: requiredTitle(200, "Без названия клиента не найти"),
  inn: optionalText(20),
  site: optionalText(200),
  contacts: z.array(contact).max(20).nullable(),
  notes: optionalText(4000),
};

export const createClientBody = z.object(clientFields).partial().required({ name: true });

export const updateClientBody = z.object(clientFields).partial();

export const listClientsQuery = z.object({
  search: z.string().trim().max(200).optional(),
});

export interface ClientDto {
  id: string;
  name: string;
  inn: string | null;
  site: string | null;
  contacts: z.infer<typeof contact>[];
  notes: string | null;
  /**
   * Сколько всего проектов и сколько идут сейчас — видно прямо в списке. Архивный
   * проект остаётся проектом клиента, но в работе уже не числится.
   */
  projectCount: number;
  activeProjectCount: number;
  createdAt: string;
  updatedAt: string;
}

type ClientWithCounts = Client & {
  projects?: { status: string; archivedAt: Date | null }[];
};

export function toClientDto(item: ClientWithCounts): ClientDto {
  const projects = item.projects ?? [];
  return {
    id: item.id,
    name: item.name,
    inn: item.inn,
    site: item.site,
    // В базе это jsonb: содержимое проверено на входе, но тип оттуда приходит
    // как unknown, и приведение здесь — единственное честное место для него.
    contacts: (item.contacts as z.infer<typeof contact>[] | null) ?? [],
    notes: item.notes,
    projectCount: projects.length,
    activeProjectCount: projects.filter(
      (project) => project.status === "active" && !project.archivedAt,
    ).length,
    createdAt: item.createdAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
  };
}
