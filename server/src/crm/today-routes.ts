import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { env } from "../env.js";
import { requireTeam } from "../auth/guard.js";
import { DEVELOPERS } from "./developers.js";
import { invalidInput } from "./http.js";
import { toProjectDto } from "./projects/dto.js";
import { toCredentialDto } from "./credentials/dto.js";
import { toTaskDto } from "./tasks/dto.js";
import { collectToday, isEmptySnapshot } from "./today.js";

/** Срез по человеку. Пустой параметр интерфейс не передаёт, «Все» — это его отсутствие. */
const todayQuery = z.object({ developer: z.enum(DEVELOPERS).optional() });

/**
 * Главный экран CRM. Отдаёт ровно то же, что бот присылает утром, — оба берут
 * данные из `collectToday`. Разница только в подаче: боту текст, экрану JSON.
 */
export async function todayRoutes(app: FastifyInstance): Promise<void> {
  app.get("/today", { preHandler: requireTeam }, async (request, reply) => {
    const query = todayQuery.safeParse(request.query);
    if (!query.success) return invalidInput(reply, query.error);

    const snapshot = await collectToday(query.data);

    return reply.send({
      empty: isEmptySnapshot(snapshot),
      tasks: {
        overdue: snapshot.tasks.overdue.map(toTaskDto),
        today: snapshot.tasks.today.map(toTaskDto),
        unassigned: snapshot.tasks.unassigned.map(toTaskDto),
      },
      credentials: {
        /*
         * Экрану — весь двухнедельный горизонт одним списком, как и раньше:
         * делить продления на горящие и далёкие нужно боту, чтобы решить,
         * писать ли вообще, а человек и так видит срок у каждой строки.
         * Обе очереди отсортированы по сроку, а горящие все раньше далёких,
         * поэтому склейка остаётся упорядоченной.
         */
        expiring: [...snapshot.credentials.urgent, ...snapshot.credentials.later].map(
          toCredentialDto,
        ),
      },
      projects: {
        urgent: snapshot.projects.urgent.map((item) => toProjectDto(item, env.TIMEZONE)),
        soon: snapshot.projects.soon.map((item) => toProjectDto(item, env.TIMEZONE)),
        unbilled: snapshot.projects.unbilled.map((item) => toProjectDto(item, env.TIMEZONE)),
      },
      money: {
        // То же деление, что и у продлений: оно нужно боту, а экрану — один список.
        unpaid: [...snapshot.money.unpaidUrgent, ...snapshot.money.unpaidLater],
        nextStages: snapshot.money.nextStages,
      },
      // Лидов для команды больше нет, но старая CRM до своего выката читает
      // `leads.overdue` и без этой заглушки падает. Удалить следующим релизом.
      leads: { overdue: [], today: [], orphanUrgent: [], unclaimed: [] },
    });
  });
}
