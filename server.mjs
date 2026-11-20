import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { classify as mockClassify } from "./mock-ai.mjs";

/** Сколько ждём ответ модели, прежде чем отдать заявку на ручной разбор. */
export const MODEL_TIMEOUT_MS = 300;
/** Темы, которые менеджер умеет обрабатывать. Всё остальное — ошибка модели. */
export const ALLOWED_TOPICS = new Set(["delivery", "pricing", "other"]);
/** Защита от случайно огромного тела запроса. */
const MAX_BODY_BYTES = 64 * 1024;

export const MANUAL_REVIEW = Object.freeze({ status: "manual_review", topic: null, draft: null });
export const INVALID_INPUT = Object.freeze({ status: "invalid_input" });

const html = await readFile(new URL("./index.html", import.meta.url));

function json(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

class PayloadTooLarge extends Error {}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new PayloadTooLarge();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Достаёт текст заявки из тела запроса.
 * Возвращает строку или null, если ввод непригоден (битый JSON, нет поля,
 * не строка, пустая строка или только пробелы).
 */
export function parseRequestText(rawBody) {
  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return null;
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
  const { text } = body;
  if (typeof text !== "string" || text.trim() === "") return null;
  return text;
}

/**
 * Проверяет сырой ответ модели по контракту.
 * Возвращает { topic, draft } или null, если ответ нельзя показывать менеджеру.
 */
export function parseModelOutput(raw) {
  if (typeof raw !== "string") return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const { topic, draft } = parsed;
  if (!ALLOWED_TOPICS.has(topic)) return null;
  if (typeof draft !== "string" || draft.trim() === "") return null;
  return { topic, draft };
}

/**
 * Вызывает модель с жёстким ограничением по времени.
 * При таймауте отменяет вызов через AbortSignal и бросает ошибку.
 */
export async function askModel(classify, text, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const timeout = new Promise((_, reject) => {
    controller.signal.addEventListener(
      "abort",
      () => reject(new Error(`model timeout after ${timeoutMs} ms`)),
      { once: true },
    );
  });
  try {
    return await Promise.race([classify(text, { signal: controller.signal }), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Собирает ответ для /api/triage. Любой сбой модели (таймаут, исключение,
 * не-JSON, недопустимая тема, пустой черновик) превращается в manual_review:
 * менеджер видит честное «разберите вручную», а не битые данные.
 */
export async function triage(text, { classify, timeoutMs }) {
  let raw;
  try {
    raw = await askModel(classify, text, timeoutMs);
  } catch (error) {
    console.warn(`[triage] manual_review: ${error.message}`);
    return MANUAL_REVIEW;
  }
  const result = parseModelOutput(raw);
  if (!result) {
    console.warn("[triage] manual_review: model output failed validation");
    return MANUAL_REVIEW;
  }
  return { status: "ready", ...result };
}

/**
 * Создаёт HTTP-сервер (без listen). Зависимости подменяемы для тестов.
 */
export function createApp({ classify = mockClassify, timeoutMs = MODEL_TIMEOUT_MS } = {}) {
  return createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(html);
      return;
    }
    if (request.method !== "POST" || request.url !== "/api/triage") {
      return json(response, 404, { status: "not_found" });
    }
    try {
      let rawBody;
      try {
        rawBody = await readBody(request);
      } catch (error) {
        if (error instanceof PayloadTooLarge) return json(response, 413, { status: "payload_too_large" });
        throw error;
      }
      const text = parseRequestText(rawBody);
      if (text === null) return json(response, 400, INVALID_INPUT);
      return json(response, 200, await triage(text, { classify, timeoutMs }));
    } catch (error) {
      console.error("[triage] unexpected error", error);
      json(response, 500, { status: "server_error" });
    }
  });
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const port = Number(process.env.PORT || 3000);
  createApp().listen(port, "127.0.0.1", () => {
    console.log(`Triage server listening on http://127.0.0.1:${port}`);
  });
}
