import type { Prisma } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit } from "../../audit.js";
import { requireTeam } from "../../auth/guard.js";
import { prisma } from "../../db.js";
import {
  MAX_AMOUNT_MINOR,
  optionalDate,
  optionalText,
  optionalUuid,
  requiredTitle,
} from "../fields.js";
import { invalidInput } from "../http.js";
import { toCredentialDto as toDto } from "./dto.js";

/** Название проекта нужно экрану для заголовка группы — тянем сразу. */
const PROJECT_BRIEF = { project: { select: { id: true, title: true } } } as const;

/**
 * Справочник учёток сервисов: что есть, на кого записано, когда продлевать и
 * под каким паролем заходят.
 *
 * **Пароли сервер не видит.** Они приходят уже зашифрованными: ключ выводится
 * из мастер-фразы в браузере и сюда не передаётся. Раньше паролей здесь не было
 * вовсе — именно потому, что база уезжает в ночные дампы, и одна их утечка
 * отдала бы разом все сервисы. Шифрование на устройстве снимает ровно это:
 * в дампе лежит нечитаемый текст.
 *
 * Отсюда следует то, что легко нарушить по невнимательности: расшифровка,
 * проверка и поиск по паролю на сервере невозможны и появиться не должны.
 * Любая такая «мелочь» потребует ключа здесь и вернёт исходную проблему.
 */

const idParams = z.object({ id: z.string().uuid() });

const credentialFields = {
  service: requiredTitle(120, "Без названия сервиса запись бесполезна"),
  login: optionalText(200),
  url: optionalText(300),
  owner: optionalText(120),
  projectId: optionalUuid,
  // Приходит уже зашифрованным. Сервер проверяет только форму и размер:
  // содержимое для него — непрозрачный набор байт, и так и задумано.
  secret: z.union([z.null(), z.string().max(4096)]),
  renewsAt: optionalDate,
  // Рубли целыми, как у проекта: копеек в абонплате не бывает.
  // Минорные единицы: сто миллионов копеек — это миллион рублей.
  amountMinor: z.union([z.null(), z.number().int().min(0).max(MAX_AMOUNT_MINOR)]),
  monthlyFee: z.boolean(),
  currency: z.enum(["rub", "usd"]),
  // 2000 своих символов плюс бывшее «Где пароль» (200) с подписью: миграция
  // дописала его в заметки, и такая запись должна сохраняться из формы.
  notes: optionalText(2400),
};

const createBody = z.object(credentialFields).partial().required({ service: true });
const updateBody = z.object(credentialFields).partial();
const listQuery = z.object({ search: z.string().trim().max(200).optional() });

export async function credentialRoutes(app: FastifyInstance): Promise<void> {
  app.get("/credentials", { preHandler: requireTeam }, async (request, reply) => {
    const query = listQuery.safeParse(request.query);
    if (!query.success) return invalidInput(reply, query.error);

    const where: Prisma.CredentialWhereInput = { deletedAt: null };
    if (query.data.search) {
      const search = query.data.search;
      where.OR = [
        { service: { contains: search, mode: "insensitive" } },
        { login: { contains: search, mode: "insensitive" } },
        { owner: { contains: search, mode: "insensitive" } },
        { notes: { contains: search, mode: "insensitive" } },
      ];
    }

    const credentials = await prisma.credential.findMany({
      include: PROJECT_BRIEF,
      where,
      // Сначала то, что скоро продлевать; без даты — в конце по алфавиту.
      orderBy: [{ renewsAt: { sort: "asc", nulls: "last" } }, { service: "asc" }],
      take: 500,
    });

    return reply.send({ credentials: credentials.map(toDto) });
  });

  app.post("/credentials", { preHandler: requireTeam }, async (request, reply) => {
    const parsed = createBody.safeParse(request.body);
    if (!parsed.success) return invalidInput(reply, parsed.error);

    const input = parsed.data;
    const credential = await prisma.credential.create({
      include: PROJECT_BRIEF,
      data: {
        service: input.service,
        login: input.login ?? null,
        url: input.url ?? null,
        owner: input.owner ?? null,
        projectId: input.projectId ?? null,
        secret: input.secret ?? null,
        renewsAt: input.renewsAt ?? null,
        amountMinor: input.amountMinor ?? null,
        monthlyFee: input.monthlyFee ?? false,
        currency: input.currency ?? "rub",
        notes: input.notes ?? null,
      },
    });

    await audit(request, {
      entity: "credentials",
      entityId: credential.id,
      action: "create",
    });
    return reply.code(201).send({ credential: toDto(credential) });
  });

  app.patch("/credentials/:id", { preHandler: requireTeam }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return invalidInput(reply, params.error);

    const parsed = updateBody.safeParse(request.body);
    if (!parsed.success) return invalidInput(reply, parsed.error);

    const existing = await prisma.credential.findFirst({
      where: { id: params.data.id, deletedAt: null },
    });
    if (!existing) return reply.code(404).send({ error: "Запись не найдена" });

    const input = parsed.data;
    const credential = await prisma.credential.update({
      include: PROJECT_BRIEF,
      where: { id: existing.id },
      data: {
        ...(input.service !== undefined && { service: input.service }),
        ...(input.login !== undefined && { login: input.login }),
        ...(input.url !== undefined && { url: input.url }),
        ...(input.owner !== undefined && { owner: input.owner }),
        ...(input.projectId !== undefined && { projectId: input.projectId }),
        ...(input.secret !== undefined && { secret: input.secret }),
        ...(input.renewsAt !== undefined && { renewsAt: input.renewsAt }),
        ...(input.amountMinor !== undefined && { amountMinor: input.amountMinor }),
        ...(input.monthlyFee !== undefined && { monthlyFee: input.monthlyFee }),
        ...(input.currency !== undefined && { currency: input.currency }),
        ...(input.notes !== undefined && { notes: input.notes }),
      },
    });

    await audit(request, {
      entity: "credentials",
      entityId: credential.id,
      action: "update",
    });
    return reply.send({ credential: toDto(credential) });
  });

  app.delete("/credentials/:id", { preHandler: requireTeam }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return invalidInput(reply, params.error);

    const existing = await prisma.credential.findFirst({
      where: { id: params.data.id, deletedAt: null },
    });
    if (!existing) return reply.code(404).send({ error: "Запись не найдена" });

    // Пароль стирается насовсем, хотя сама запись удаляется мягко. Шифротекст
    // без мастер-фразы нечитаем, но хранить его вечно незачем: он уезжает в
    // каждый ночной дамп и переживёт любую будущую ошибку в криптографии.
    // Цена — восстановленная запись придёт без пароля; экрана восстановления
    // всё равно нет, а появится — пусть требует ввести пароль заново.
    await prisma.credential.update({
      where: { id: existing.id },
      data: { deletedAt: new Date(), secret: null },
    });

    await audit(request, {
      entity: "credentials",
      entityId: existing.id,
      action: "delete",
      diff: { service: existing.service },
    });
    return reply.code(204).send();
  });
}
