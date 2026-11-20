import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createApp, MANUAL_REVIEW, MODEL_TIMEOUT_MS, parseModelOutput, parseRequestText } from "../server.mjs";

const MANUAL = { ...MANUAL_REVIEW };

describe("POST /api/triage", () => {
  let server;
  let base;

  before(async () => {
    server = createApp();
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => new Promise((resolve) => server.close(resolve)));

  async function post(body, { raw = false } = {}) {
    const response = await fetch(`${base}/api/triage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: raw ? body : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  }

  describe("некорректный ввод → 400 invalid_input", () => {
    for (const [name, payload] of [
      ["пустая строка", { text: "" }],
      ["только пробелы", { text: "   \n\t" }],
      ["поле отсутствует", {}],
      ["не строка", { text: 42 }],
      ["null", { text: null }],
      ["массив вместо объекта", [{ text: "x" }]],
    ]) {
      test(name, async () => {
        const { status, body } = await post(payload);
        assert.equal(status, 400);
        assert.deepEqual(body, { status: "invalid_input" });
      });
    }

    test("битый JSON", async () => {
      const { status, body } = await post("{ text: ", { raw: true });
      assert.equal(status, 400);
      assert.deepEqual(body, { status: "invalid_input" });
    });
  });

  describe("сбои модели → 200 manual_review", () => {
    test("[timeout]: ответ приходит около лимита в 300 мс, а не через 1200", async () => {
      const started = performance.now();
      const { status, body } = await post({ text: "Где моя доставка? [timeout]" });
      const elapsed = performance.now() - started;
      assert.equal(status, 200);
      assert.deepEqual(body, MANUAL);
      assert.ok(elapsed >= MODEL_TIMEOUT_MS - 20, `слишком быстро: ${elapsed.toFixed(0)} мс`);
      assert.ok(elapsed < 900, `таймаут не сработал: ${elapsed.toFixed(0)} мс`);
    });

    for (const [name, text] of [
      ["[error]: исключение провайдера", "Сколько стоит? [error]"],
      ["[bad-json]: ответ не JSON", "Сколько стоит? [bad-json]"],
      ["[bad-topic]: тема вне списка", "Сколько стоит? [bad-topic]"],
      ["[empty-draft]: пустой черновик", "Сколько стоит? [empty-draft]"],
    ]) {
      test(name, async () => {
        const { status, body } = await post({ text });
        assert.equal(status, 200);
        assert.deepEqual(body, MANUAL);
      });
    }
  });

  describe("успешный ответ → 200 ready", () => {
    test("доставка", async () => {
      const { status, body } = await post({ text: "Когда будет доставка заказа?" });
      assert.equal(status, 200);
      assert.equal(body.status, "ready");
      assert.equal(body.topic, "delivery");
      assert.ok(typeof body.draft === "string" && body.draft.trim().length > 0);
    });

    test("цены", async () => {
      const { body } = await post({ text: "Какая цена на тариф Про?" });
      assert.equal(body.topic, "pricing");
    });

    test("другое", async () => {
      const { body } = await post({ text: "Здравствуйте, у меня вопрос" });
      assert.equal(body.topic, "other");
    });
  });

  test("прочие маршруты → 404", async () => {
    const response = await fetch(`${base}/api/unknown`, { method: "POST", body: "{}" });
    assert.equal(response.status, 404);
  });
});

describe("createApp с подменённой моделью", () => {
  test("медленная модель со своим лимитом тоже уходит в manual_review", async () => {
    const slow = () => new Promise((resolve) => setTimeout(() => resolve('{"topic":"other","draft":"late"}'), 200));
    const server = createApp({ classify: slow, timeoutMs: 50 });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/triage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "тест" }),
      });
      assert.deepEqual(await response.json(), MANUAL);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe("валидаторы", () => {
  test("parseRequestText", () => {
    assert.equal(parseRequestText('{"text":"ok"}'), "ok");
    assert.equal(parseRequestText('{"text":"  "}'), null);
    assert.equal(parseRequestText("null"), null);
    assert.equal(parseRequestText("not json"), null);
  });

  test("parseModelOutput", () => {
    assert.deepEqual(parseModelOutput('{"topic":"pricing","draft":"Hi"}'), { topic: "pricing", draft: "Hi" });
    assert.equal(parseModelOutput('{"topic":"refund","draft":"Hi"}'), null);
    assert.equal(parseModelOutput('{"topic":"other","draft":"   "}'), null);
    assert.equal(parseModelOutput('{"topic":"other"}'), null);
    assert.equal(parseModelOutput("plain text"), null);
    assert.equal(parseModelOutput(undefined), null);
  });
});
