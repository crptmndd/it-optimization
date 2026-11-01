import { api } from "./client";

/**
 * Поиск по всей CRM. Раздел искать не нужно — достаточно помнить название,
 * контакт или обрывок заметки.
 */
export interface SearchHit {
  entity: "clients" | "projects" | "tasks" | "credentials";
  label: string;
  id: string;
  title: string;
  /** Чем эта запись отличается от соседней с тем же названием. */
  hint: string | null;
}

export async function search(q: string): Promise<SearchHit[]> {
  const { hits, notes } = await api.get<{ hits: SearchHit[]; notes: SearchHit[] }>(
    `/search?q=${encodeURIComponent(q)}`,
  );
  // Совпадения по заметкам идут после совпадений по названию: человек чаще
  // ищет то, как запись называется, а не что о ней когда-то написали.
  return [...hits, ...notes];
}
