import type { Currency, Prisma, ProjectStage } from "@prisma/client";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { audit } from "../../audit.js";
import { requireAdmin } from "../../auth/guard.js";
import { prisma } from "../../db.js";
import { sumByCurrency } from "../currency.js";
import { MAX_AMOUNT_MINOR, optionalDate, optionalText } from "../fields.js";
import { invalidInput } from "../http.js";
import { billingMode, type ProjectPayment } from "./dto.js";

/**
 * Этапы договора: три части одной суммы, которые клиент оплачивает по очереди.
 *
 * Отдельная таблица, а не строки `invoices`: два этапа могут прийтись на один
 * месяц и упёрлись бы в уникальность счёта за период, а обойти её можно только
 * частичным индексом, которого Prisma не описывает. Заодно порядок оплаты нельзя
 * обойти через маршруты счетов: этапы туда просто не попадают, и проверка живёт
 * в одном месте — здесь.
 *
 * Общая сумма договора не хранится: это сумма этапов. Второе хранимое число
 * однажды разошлось бы с первым. Своя `currency` у каждого этапа нужна потому,
 * что валюта проекта может смениться, а смысл уже оплаченной суммы — нет.
 */

export const STAGE_POSITIONS = [1, 2, 3] as const;

/** Идемпотентно: существующие этапы не трогает. */
export async function ensureStages(
  tx: Prisma.TransactionClient,
  projectId: string,
  currency: Currency,
): Promise<void> {
  await tx.projectStage.createMany({
    data: STAGE_POSITIONS.map((position) => ({ projectId, position, currency })),
    skipDuplicates: true,
  });
}

/** Равные части, копейки остатка на последнюю: 10001 → 3333, 3333, 3335. */
export function splitAmount(totalMinor: number, parts: number): number[] {
  const part = Math.floor(totalMinor / parts);
  return Array.from({ length: parts }, (_, index) =>
    index === parts - 1 ? totalMinor - part * (parts - 1) : part,
  );
}

export interface StageDto {
  id: string;
  position: number;
  amountMinor: number | null;
  currency: Currency;
  issuedAt: string | null;
  paidAt: string | null;
  note: string | null;
  /** Можно отметить оплату: не оплачен, предыдущий оплачен, проект платит этапами. */
  payable: boolean;
  /** Можно снять оплату: оплачен, и следующий не оплачен. */
  unpayable: boolean;
}

type StageRow = Pick<
  ProjectStage,
  "id" | "position" | "amountMinor" | "currency" | "issuedAt" | "paidAt" | "note"
>;

export function toStageDto(
  stage: StageRow,
  stages: StageRow[],
  mode: ProjectPayment["mode"],
): StageDto {
  const previous = stages.find((item) => item.position === stage.position - 1);
  const next = stages.find((item) => item.position === stage.position + 1);
  return {
    id: stage.id,
    position: stage.position,
    amountMinor: stage.amountMinor,
    currency: stage.currency,
    issuedAt: stage.issuedAt?.toISOString() ?? null,
    paidAt: stage.paidAt?.toISOString() ?? null,
    note: stage.note,
    payable: !stage.paidAt && mode === "stages" && (!previous || !!previous.paidAt),
    unpayable: !!stage.paidAt && !next?.paidAt,
  };
}

function stagesPayload(stages: StageRow[], mode: ProjectPayment["mode"]) {
  return {
    stages: stages.map((stage) => toStageDto(stage, stages, mode)),
    totals: sumByCurrency(stages),
  };
}

/** Отказ внутри транзакции: откатывает её и превращается в ответ с этим кодом. */
class StageRefusal extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    message: string,
  ) {
    super(message);
  }
}

function refuse(reply: FastifyReply, cause: unknown): FastifyReply {
  if (cause instanceof StageRefusal) {
    return reply.code(cause.status).send({ error: cause.message });
  }
  throw cause;
}

/**
 * Запись этапов идёт только под блокировкой строки проекта. Иначе две
 * одновременные отметки обойдут порядок оплаты, а отметка, пришедшая между
 * чтением и записью сумм, даст новую сумму уже оплаченному этапу. Заодно здесь
 * отсекается удалённый проект, а режим читается из заблокированной строки.
 */
async function lockProject(
  tx: Prisma.TransactionClient,
  projectId: string,
): Promise<{ mode: ProjectPayment["mode"]; currency: Currency }> {
  const [project] = await tx.$queryRaw<
    { work_type: string | null; billing_monthly: boolean; currency: Currency }[]
  >`SELECT work_type, billing_monthly, currency::text AS currency FROM projects
    WHERE id = ${projectId}::uuid AND deleted_at IS NULL
    FOR UPDATE`;
  if (!project) throw new StageRefusal(404, "Проект не найден");
  return {
    mode: billingMode({
      workType: project.work_type,
      billingMonthly: project.billing_monthly,
    }),
    currency: project.currency,
  };
}

/** Новые суммы по общей: оплаченное не меняется, остаток поровну на неоплаченные. */
function amountsFromTotal(
  stages: StageRow[],
  totalMinor: number | null,
): (number | null)[] {
  const unpaid = stages.filter((stage) => !stage.paidAt);
  // splitAmount(x, 0) вернул бы пустой список, и сумма молча пропала бы при 200.
  if (unpaid.length === 0) throw new StageRefusal(409, "Все этапы оплачены");
  if (totalMinor === null) {
    return stages.map((stage) => (stage.paidAt ? stage.amountMinor : null));
  }

  const paidMinor = stages.reduce(
    (sum, stage) => sum + (stage.paidAt ? (stage.amountMinor ?? 0) : 0),
    0,
  );
  const rest = totalMinor - paidMinor;
  if (rest < 0) throw new StageRefusal(409, "Сумма меньше уже оплаченного");

  const parts = splitAmount(rest, unpaid.length);
  // Предел на общую сумму этого не гарантирует: 3 * MAX - 1 даёт последнюю часть
  // MAX + 1, а при оплаченном этапе части доходят до 1,5 MAX. Без проверки это
  // переполнение INTEGER и ответ 500.
  if (parts.some((part) => part > MAX_AMOUNT_MINOR)) {
    throw new StageRefusal(400, "Сумма этапа больше допустимой");
  }
  return stages.map((stage) =>
    stage.paidAt ? stage.amountMinor : (parts.shift() ?? null),
  );
}

/** Суммы по этапам. Заполненную сумму оплаченного этапа менять нельзя. */
function checkAmounts(stages: StageRow[], amounts: (number | null)[]): (number | null)[] {
  const frozen = stages.some(
    (stage, index) =>
      stage.paidAt && stage.amountMinor !== null && stage.amountMinor !== amounts[index],
  );
  if (frozen) throw new StageRefusal(409, "Сумма оплаченного этапа не меняется");
  return amounts;
}

const stageParams = z.object({
  id: z.string().uuid(),
  position: z.coerce.number().int().min(1).max(STAGE_POSITIONS.length),
});
const projectParams = z.object({ id: z.string().uuid() });

const stageAmount = z.union([z.null(), z.number().int().min(0).max(MAX_AMOUNT_MINOR)]);

const stagesBody = z
  .object({
    totalMinor: z
      .union([
        z.null(),
        z
          .number()
          .int()
          .min(0)
          .max(3 * MAX_AMOUNT_MINOR),
      ])
      .optional(),
    amounts: z.tuple([stageAmount, stageAmount, stageAmount]).optional(),
    currency: z.enum(["rub", "usd"]).optional(),
  })
  .refine(
    (body) => (body.totalMinor === undefined) !== (body.amounts === undefined),
    "Нужно ровно одно: totalMinor или amounts",
  );

const stageBody = z.object({
  paidAt: optionalDate.optional(),
  issuedAt: optionalDate.optional(),
  note: optionalText(500).optional(),
});

export async function stageRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/projects/:id/stages",
    { preHandler: requireAdmin },
    async (request, reply) => {
      const params = projectParams.safeParse(request.params);
      if (!params.success) return invalidInput(reply, params.error);

      const project = await prisma.project.findFirst({
        where: { id: params.data.id, deletedAt: null },
        select: {
          workType: true,
          billingMonthly: true,
          stages: { orderBy: { position: "asc" } },
        },
      });
      if (!project) return reply.code(404).send({ error: "Проект не найден" });

      return reply.send(stagesPayload(project.stages, billingMode(project)));
    },
  );

  /** Суммы этапов: общая с разбивкой поровну или каждая своя. */
  app.put(
    "/projects/:id/stages",
    { preHandler: requireAdmin },
    async (request, reply) => {
      const params = projectParams.safeParse(request.params);
      if (!params.success) return invalidInput(reply, params.error);

      const parsed = stagesBody.safeParse(request.body);
      if (!parsed.success) return invalidInput(reply, parsed.error);

      const projectId = params.data.id;
      const { totalMinor, amounts, currency } = parsed.data;

      try {
        const result = await prisma.$transaction(async (tx) => {
          const locked = await lockProject(tx, projectId);
          if (locked.mode !== "stages") {
            throw new StageRefusal(409, "Проект платится не этапами");
          }

          // Договор, заведённый старым API при откате, мог остаться без этапов.
          await ensureStages(tx, projectId, locked.currency);
          const stages = await tx.projectStage.findMany({
            where: { projectId },
            orderBy: { position: "asc" },
          });

          if (currency && stages.some((it) => it.paidAt && it.currency !== currency)) {
            throw new StageRefusal(409, "Есть оплаченный этап в другой валюте");
          }

          const next =
            amounts !== undefined
              ? checkAmounts(stages, amounts)
              : amountsFromTotal(stages, totalMinor ?? null);

          const updated: ProjectStage[] = [];
          for (const [index, stage] of stages.entries()) {
            updated.push(
              await tx.projectStage.update({
                where: { id: stage.id },
                data: {
                  amountMinor: next[index] ?? null,
                  ...(currency && !stage.paidAt && { currency }),
                },
              }),
            );
          }

          // Блока оплаты у договора нет, другого способа сменить валюту проекта не
          // осталось, а от неё зависит значение по умолчанию в «Счета и акты».
          if (currency) {
            await tx.project.updateMany({
              where: { id: projectId, currency: { not: currency } },
              data: { currency },
            });
          }

          return { mode: locked.mode, stages: updated, before: stages };
        });

        await audit(request, {
          entity: "project_stages",
          entityId: projectId,
          action: "update",
          diff: {
            amountMinor: {
              from: result.before.map((stage) => stage.amountMinor),
              to: result.stages.map((stage) => stage.amountMinor),
            },
            ...(currency && { currency }),
          },
        });

        return reply.send(stagesPayload(result.stages, result.mode));
      } catch (cause) {
        return refuse(reply, cause);
      }
    },
  );

  app.patch(
    "/projects/:id/stages/:position",
    { preHandler: requireAdmin },
    async (request, reply) => {
      const params = stageParams.safeParse(request.params);
      if (!params.success) return invalidInput(reply, params.error);

      const parsed = stageBody.safeParse(request.body);
      if (!parsed.success) return invalidInput(reply, parsed.error);

      const { id: projectId, position } = params.data;
      const input = parsed.data;

      try {
        const result = await prisma.$transaction(async (tx) => {
          const { mode } = await lockProject(tx, projectId);
          const stages = await tx.projectStage.findMany({
            where: { projectId },
            orderBy: { position: "asc" },
          });
          const stage = stages.find((item) => item.position === position);
          if (!stage) throw new StageRefusal(404, "Этап не найден");

          if (input.paidAt) {
            // Скрытый этап нигде бы не всплыл, и оплата потерялась бы из виду.
            // Снять оплату можно при любом режиме: ошибочную отметку надо чем-то
            // исправить.
            if (mode !== "stages") {
              throw new StageRefusal(409, "Проект платится не этапами");
            }
            const previous = stages.find((item) => item.position === position - 1);
            if (previous && !previous.paidAt) {
              throw new StageRefusal(
                409,
                `Сначала отметьте оплату этапа ${previous.position}`,
              );
            }
          }
          if (input.paidAt === null) {
            const next = stages.find((item) => item.position === position + 1);
            if (next?.paidAt) {
              throw new StageRefusal(
                409,
                `Сначала снимите оплату этапа ${next.position}`,
              );
            }
          }

          const paidAt = input.paidAt !== undefined ? input.paidAt : stage.paidAt;
          // Дата, подставленная оплатой, следует за ней: после снятия остался бы
          // «выставлен» у этапа, который никто не выставлял. Введённую руками дату
          // снятие не трогает.
          const issuedByPayment =
            stage.paidAt !== null && stage.issuedAt?.getTime() === stage.paidAt.getTime();
          const issuedAt =
            input.issuedAt !== undefined
              ? input.issuedAt
              : issuedByPayment
                ? paidAt
                : stage.issuedAt;
          const updated = await tx.projectStage.update({
            where: { id: stage.id },
            data: {
              paidAt,
              // У оплаченного этапа всегда обе даты: колонке «когда» в «Счетах»
              // иначе нечего показать в графе «выставлен».
              issuedAt: paidAt && !issuedAt ? paidAt : issuedAt,
              ...(input.note !== undefined && { note: input.note }),
            },
          });

          return {
            mode,
            previousPaidAt: stage.paidAt,
            updated,
            stages: stages.map((item) => (item.id === updated.id ? updated : item)),
          };
        });

        await audit(request, {
          entity: "project_stages",
          entityId: result.updated.id,
          action: "update",
          diff: {
            paidAt: {
              from: result.previousPaidAt?.toISOString() ?? null,
              to: result.updated.paidAt?.toISOString() ?? null,
            },
          },
        });

        return reply.send({
          stage: toStageDto(result.updated, result.stages, result.mode),
          stages: result.stages.map((item) =>
            toStageDto(item, result.stages, result.mode),
          ),
        });
      } catch (cause) {
        return refuse(reply, cause);
      }
    },
  );
}
