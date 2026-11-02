import type { Currency, Invoice } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit } from "../../audit.js";
import { requireTeam } from "../../auth/guard.js";
import { prisma } from "../../db.js";
import { periodTitle } from "../../notify/zone.js";
import { sumByCurrency } from "../currency.js";
import { invalidInput } from "../http.js";
import { listBills } from "./bills.js";
import { billingMode, invoiceBody } from "./dto.js";
import { rememberUnbilledMonth } from "./monthly-documents.js";

/**
 * Счета и акты по проекту.
 *
 * CRM не рисует документы — она помнит, за какой месяц что выставлено и оплачено.
 * Болит не рисование счёта, а «за апрель забыли». У помесячных проектов записи
 * заводит планировщик (`monthly-documents.ts`), остальные заводятся здесь руками.
 */

const projectParams = z.object({ id: z.string().uuid() });
const invoiceParams = z.object({ id: z.string().uuid(), invoiceId: z.string().uuid() });

export interface InvoiceDto {
  id: string;
  kind: "invoice" | "act";
  period: string;
  amountMinor: number | null;
  currency: Currency;
  issuedAt: string | null;
  paidAt: string | null;
  note: string | null;
}

export function toInvoiceDto(item: Invoice): InvoiceDto {
  return {
    id: item.id,
    kind: item.kind,
    period: item.period,
    amountMinor: item.amountMinor,
    currency: item.currency,
    issuedAt: item.issuedAt?.toISOString() ?? null,
    paidAt: item.paidAt?.toISOString() ?? null,
    note: item.note,
  };
}

async function projectExists(id: string): Promise<boolean> {
  return (await prisma.project.count({ where: { id, deletedAt: null } })) > 0;
}

/**
 * Счёт, заведённый на этап по привычке, встал бы в «К оплате» рядом с самим
 * этапом: итог задвоился бы, а порядок оплаты обошёлся бы через эти маршруты.
 * Акты разрешены: они про документы, а не про деньги.
 */
async function paidByStages(projectId: string): Promise<boolean> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { workType: true, billingMonthly: true },
  });
  return project !== null && billingMode(project) === "stages";
}

const STAGES_ONLY = "Договор оплачивается этапами";

const listQuery = z.object({
  /**
   * due — к оплате, paid — оплачено, all — все, вместе с этапами договоров.
   * unpaid — старый срез без этапов и в старой форме: его вызывает CRM до своего
   * выката, и без него старый экран упадёт на `periodLabel(null)`. Удалить
   * следующим релизом.
   */
  scope: z.enum(["due", "paid", "all", "unpaid"]).default("due"),
});

export async function invoiceRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Все счета разом, поверх проектов.
   *
   * Без этого «кто нам должен» отвечается только обходом каждого проекта по
   * очереди — то есть не отвечается вовсе. Здесь же общая сумма долга.
   */
  app.get("/invoices", { preHandler: requireTeam }, async (request, reply) => {
    const query = listQuery.safeParse(request.query);
    if (!query.success) return invalidInput(reply, query.error);

    if (query.data.scope !== "unpaid") {
      const bills = await listBills(query.data.scope);
      return reply.send({
        invoices: bills.slice(0, 500),
        // По всему срезу, а не по обрезанному: иначе итог занизил бы долг. Не
        // число, а по числу на валюту: курса у CRM нет.
        totals: sumByCurrency(bills),
      });
    }

    const invoices = await prisma.invoice.findMany({
      where: { kind: "invoice", project: { deletedAt: null }, paidAt: null },
      orderBy: [{ period: "asc" }],
      include: {
        project: { select: { id: true, title: true, client: { select: { name: true } } } },
      },
      take: 500,
    });

    return reply.send({
      invoices: invoices.map((invoice) => ({
        ...toInvoiceDto(invoice),
        project: {
          id: invoice.project.id,
          title: invoice.project.title,
          client: invoice.project.client?.name ?? null,
        },
      })),
      // Считается на сервере: клиент иначе сложил бы только то, что попало в
      // выдачу, и цифра врала бы при обрезке по take. Итог не число, а по
      // числу на валюту — курса у CRM нет, складывать разное нечем.
      totals: sumByCurrency(invoices),
    });
  });

  app.get("/projects/:id/invoices", { preHandler: requireTeam }, async (request, reply) => {
    const params = projectParams.safeParse(request.params);
    if (!params.success) return invalidInput(reply, params.error);
    if (!(await projectExists(params.data.id))) {
      return reply.code(404).send({ error: "Проект не найден" });
    }

    const invoices = await prisma.invoice.findMany({
      where: { projectId: params.data.id },
      // Свежие периоды сверху: чаще всего смотрят текущий месяц.
      orderBy: [{ period: "desc" }, { kind: "asc" }],
    });

    return reply.send({ invoices: invoices.map(toInvoiceDto) });
  });

  app.post("/projects/:id/invoices", { preHandler: requireTeam }, async (request, reply) => {
    const params = projectParams.safeParse(request.params);
    if (!params.success) return invalidInput(reply, params.error);

    const parsed = invoiceBody.safeParse(request.body);
    if (!parsed.success) return invalidInput(reply, parsed.error);

    if (!(await projectExists(params.data.id))) {
      return reply.code(404).send({ error: "Проект не найден" });
    }

    const input = parsed.data;
    if (input.kind === "invoice" && (await paidByStages(params.data.id))) {
      return reply.code(409).send({ error: STAGES_ONLY });
    }

    // Уникальность (проект, вид, период) держит база. Ловим её здесь, чтобы
    // вместо «внутренней ошибки» человек увидел, что именно не так.
    const duplicate = await prisma.invoice.count({
      where: { projectId: params.data.id, kind: input.kind, period: input.period },
    });
    if (duplicate) {
      const what = input.kind === "invoice" ? "Счёт" : "Акт";
      return reply
        .code(409)
        .send({ error: `${what} за ${periodTitle(input.period)} уже заведён` });
    }

    const invoice = await prisma.invoice.create({
      data: {
        projectId: params.data.id,
        kind: input.kind,
        period: input.period,
        amountMinor: input.amountMinor ?? null,
        currency: input.currency ?? "rub",
        issuedAt: input.issuedAt ?? null,
        paidAt: input.paidAt ?? null,
        note: input.note ?? null,
      },
    });

    await audit(request, { entity: "invoices", entityId: invoice.id, action: "create" });
    return reply.code(201).send({ invoice: toInvoiceDto(invoice) });
  });

  app.patch(
    "/projects/:id/invoices/:invoiceId",
    { preHandler: requireTeam },
    async (request, reply) => {
      const params = invoiceParams.safeParse(request.params);
      if (!params.success) return invalidInput(reply, params.error);

      const parsed = invoiceBody.partial().safeParse(request.body);
      if (!parsed.success) return invalidInput(reply, parsed.error);

      const existing = await prisma.invoice.findFirst({
        where: { id: params.data.invoiceId, projectId: params.data.id },
      });
      if (!existing) return reply.code(404).send({ error: "Запись не найдена" });

      const input = parsed.data;
      // Тот же запрет с другого входа: акт, ставший счётом, обошёл бы его.
      const becomesInvoice = input.kind === "invoice" && existing.kind !== "invoice";
      if (becomesInvoice && (await paidByStages(params.data.id))) {
        return reply.code(409).send({ error: STAGES_ONLY });
      }

      const invoice = await prisma.$transaction(async (tx) => {
        const updated = await tx.invoice.update({
          where: { id: existing.id },
          data: {
            ...(input.kind !== undefined && { kind: input.kind }),
            ...(input.period !== undefined && { period: input.period }),
            ...(input.amountMinor !== undefined && { amountMinor: input.amountMinor }),
            ...(input.currency !== undefined && { currency: input.currency }),
            ...(input.issuedAt !== undefined && { issuedAt: input.issuedAt }),
            ...(input.paidAt !== undefined && { paidAt: input.paidAt }),
            ...(input.note !== undefined && { note: input.note }),
          },
        });
        // Единственная запись могла уехать в будущее или стать актом.
        await rememberUnbilledMonth(tx, existing.projectId);
        return updated;
      });

      await audit(request, { entity: "invoices", entityId: invoice.id, action: "update" });
      return reply.send({ invoice: toInvoiceDto(invoice) });
    },
  );

  app.delete(
    "/projects/:id/invoices/:invoiceId",
    { preHandler: requireTeam },
    async (request, reply) => {
      const params = invoiceParams.safeParse(request.params);
      if (!params.success) return invalidInput(reply, params.error);

      const existing = await prisma.invoice.findFirst({
        where: { id: params.data.invoiceId, projectId: params.data.id },
      });
      if (!existing) return reply.code(404).send({ error: "Запись не найдена" });

      // Жёстко, в отличие от остальных сущностей: ошибочно заведённый счёт —
      // это опечатка, а не история, и висеть в отчётах ему незачем.
      await prisma.$transaction(async (tx) => {
        await tx.invoice.delete({ where: { id: existing.id } });
        // Месяц без записи показан как пропуск и должен им остаться: запуск за
        // следующий месяц иначе создал бы новую первую запись и убрал его молча.
        await rememberUnbilledMonth(tx, existing.projectId);
      });

      await audit(request, {
        entity: "invoices",
        entityId: existing.id,
        action: "delete",
        diff: { kind: existing.kind, period: existing.period },
      });
      return reply.code(204).send();
    },
  );
}
