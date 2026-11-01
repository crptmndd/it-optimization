import { api } from "./client";
import type { Credential } from "./credentials";
import type { Bill, Project } from "./projects";
import type { Task } from "./tasks";

/**
 * То же, что бот присылает утром. Один источник на сервере (`collectToday`) —
 * поэтому экран и сообщение в телеграме не могут разойтись.
 */
export interface TodaySnapshot {
  empty: boolean;
  tasks: {
    overdue: Task[];
    today: Task[];
    /** В работе или на очереди, но без исполнителя и без горящего срока. */
    unassigned: Task[];
  };
  /** Сервисы, которым до продления осталось меньше двух недель. */
  credentials: {
    expiring: Credential[];
  };
  projects: {
    urgent: Project[];
    /** Срок в ближайшие семь дней. */
    soon: Project[];
    /** Помесячные проекты с пробелом в счетах — считает сервер. */
    unbilled: Project[];
  };
  money: {
    /** Счета к оплате, старые сверху. */
    unpaid: Bill[];
    /** Следующий неоплаченный этап каждого договора. */
    nextStages: Bill[];
  };
}

/** Без имени — вся команда. Пустой параметр сервер отверг бы как неизвестное имя. */
export async function getToday(developer?: string): Promise<TodaySnapshot> {
  const query = developer ? `?developer=${encodeURIComponent(developer)}` : "";
  return api.get<TodaySnapshot>(`/today${query}`);
}
