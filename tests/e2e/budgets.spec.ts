import { test, expect, type Page } from "./fixtures";

async function createBudget(page: Page, category: string, limit = "100.00") {
  await page.getByRole("button", { name: "Add Budget", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add Budget", exact: true });
  await dialog.getByLabel("Category", { exact: true }).selectOption({ label: category });
  await dialog.getByLabel("Monthly limit").fill(limit);
  await dialog.getByRole("button", { name: "Create Budget" }).click();
  await expect(dialog).toBeHidden();
  await expect(
    page.getByRole("article", { name: category.split(" / ").at(-1), exact: true }),
  ).toBeVisible();
}

async function addTransaction(page: Page, amount: string, income = false) {
  await page.getByRole("banner").getByRole("button", { name: "Add Transaction" }).click();
  const dialog = page.getByRole("dialog", { name: "New Transaction" });
  await dialog.getByLabel("Date").fill(new Date().toISOString().slice(0, 10) + "T12:00");
  await dialog.getByLabel("Description").fill("Budget UI " + crypto.randomUUID());
  await dialog.getByRole("spinbutton", { name: "Amount", exact: true }).fill(amount);
  await dialog.getByLabel("Account").selectOption({ label: "Main (PLN)" });
  const category = dialog.getByLabel("Category", { exact: true });
  const fruitId = await category.getByRole("option", { name: /Fruits/ }).getAttribute("value");
  await category.selectOption(fruitId!);
  if (income) await dialog.getByLabel("Income").check();
  await dialog.getByRole("button", { name: "Create Transaction" }).click();
  await expect(dialog).toBeHidden();
}

test("requires authentication", async ({ page, unauthUser: _unauthUser }) => {
  await page.goto("/budgets");
  await expect(page).toHaveURL(/\/login/);
});

test("navigation, empty state, creation, limit editing, cancellation and deletion", async ({
  page,
  signedInUser: _user,
}) => {
  await page.goto("/dashboard");
  await page.getByRole("link", { name: "Budgets", exact: true }).click();
  await expect(page).toHaveURL("/budgets");
  await expect(page.getByRole("heading", { name: "No budgets yet" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Budget plan usage" })).toContainText(
    "Free plan: 0 of 3 budgets",
  );
  await createBudget(page, "Groceries");
  const card = page.getByRole("article", { name: "Groceries", exact: true });
  await expect(card).toContainText("100.00");
  await expect(card).toContainText("Within budget");
  await card.getByRole("button", { name: "Edit Limit" }).click();
  const edit = page.getByRole("dialog", { name: "Edit Limit" });
  await expect(edit.getByLabel("Monthly limit")).toHaveValue("100.00");
  await edit.getByLabel("Monthly limit").fill("50.00");
  await edit.getByRole("button", { name: "Save Changes" }).click();
  await expect(edit).toBeHidden();
  await expect(card).toContainText("50.00");
  await page.reload();
  await expect(card).toContainText("50.00");
  await card.getByRole("button", { name: "Delete", exact: true }).click();
  const confirmation = page.getByRole("alertdialog", { name: "Delete Budget" });
  await confirmation.getByRole("button", { name: "Cancel" }).click();
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "Delete", exact: true }).click();
  await confirmation.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(confirmation).toBeHidden();
  await expect(card).toBeHidden();
  await expect(page.getByRole("heading", { name: "No budgets yet" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Budget plan usage" })).toContainText(
    "Free plan: 0 of 3 budgets",
  );
});

test("validates positive limits and prevents selecting an already-budgeted category", async ({
  page,
  signedInUser: _user,
}) => {
  await page.goto("/budgets");
  await createBudget(page, "Groceries");
  await page.getByRole("button", { name: "Add Budget" }).click();
  const dialog = page.getByRole("dialog", { name: "Add Budget", exact: true });
  await expect(
    dialog.getByLabel("Category").getByRole("option", { name: "Groceries", exact: true }),
  ).toHaveCount(0);
  await dialog.getByLabel("Monthly limit").fill("10");
  await dialog.getByRole("button", { name: "Create Budget" }).click();
  await expect(dialog.getByRole("alert")).toHaveText("Choose a category for your budget.");
  await dialog.getByLabel("Category").selectOption({ label: "Housing" });
  for (const limit of ["0", "-1", "1.001", "21474836.48"]) {
    await dialog.getByLabel("Monthly limit").fill(limit);
    await dialog.getByRole("button", { name: "Create Budget" }).click();
    await expect(dialog.getByRole("alert")).toContainText("Enter a positive limit");
  }
  await dialog.getByLabel("Monthly limit").fill("12,34");
  await dialog.getByRole("button", { name: "Create Budget" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("article", { name: "Housing", exact: true })).toContainText("12.34");
});

test("shows descendant spending, ignores income, and distinguishes reaching and exceeding a limit", async ({
  page,
  signedInUser: _user,
}) => {
  await page.goto("/budgets");
  await createBudget(page, "Groceries");
  await page.getByRole("link", { name: "Transactions", exact: true }).click();
  await addTransaction(page, "100.00");
  await addTransaction(page, "1000.00", true);
  await page.getByRole("link", { name: "Budgets", exact: true }).click();
  const card = page.getByRole("article", { name: "Groceries", exact: true });
  await expect(card).toContainText("Limit reached");
  await expect(card).toContainText("0.00");
  await page.getByRole("link", { name: "Transactions", exact: true }).click();
  await addTransaction(page, "0.01");
  await page.getByRole("link", { name: "Budgets", exact: true }).click();
  await expect(card).toContainText("Over budget");
  await expect(card).toContainText("100.01");
  await expect(card).toContainText("-0.01");
  await card.getByRole("button", { name: "Edit Limit" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit Limit" });
  await dialog.getByLabel("Monthly limit").fill("200");
  await dialog.getByRole("button", { name: "Save Changes" }).click();
  await expect(dialog).toBeHidden();
  await expect(card).toContainText("Within budget");
  await expect(card).toContainText("99.99");
});

test("enforces Free usage and preserves editable budgets after a Pro downgrade", async ({
  page,
  signedInUser: _user,
}) => {
  await page.goto("/budgets");
  for (const name of ["Groceries", "Housing", "Transport"]) await createBudget(page, name);
  await expect(page.getByRole("button", { name: "Add Budget" })).toBeDisabled();
  await expect(page.getByRole("region", { name: "Budget plan usage" })).toContainText(
    "Free plan: 3 of 3 budgets",
  );
  await page.getByRole("link", { name: "View plans" }).click();
  await expect(page).toHaveURL("/billing");
  expect((await page.request.post("/test-set-plan?plan=pro")).ok()).toBe(true);
  await page.goto("/budgets");
  await createBudget(page, "Entertainment");
  await expect(page.getByRole("region", { name: "Budget plan usage" })).toContainText(
    "Pro plan: 4 budgets (unlimited)",
  );
  expect((await page.request.post("/test-set-plan?plan=free")).ok()).toBe(true);
  await page.reload();
  await expect(page.getByRole("article")).toHaveCount(4);
  await expect(page.getByRole("button", { name: "Add Budget" })).toBeDisabled();
  const card = page.getByRole("article", { name: "Entertainment", exact: true });
  await card.getByRole("button", { name: "Edit Limit" }).click();
  const edit = page.getByRole("dialog", { name: "Edit Limit" });
  await edit.getByLabel("Monthly limit").fill("150");
  await edit.getByRole("button", { name: "Save Changes" }).click();
  await expect(edit).toBeHidden();
  await expect(card).toContainText("150.00");
  await card.getByRole("button", { name: "Delete", exact: true }).click();
  await page
    .getByRole("alertdialog", { name: "Delete Budget" })
    .getByRole("button", { name: "Delete", exact: true })
    .click();
  await expect(card).toBeHidden();
  await expect(page.getByRole("button", { name: "Add Budget" })).toBeDisabled();
});

test("shows mutation failures and permits retry without losing the form", async ({
  page,
  signedInUser: _user,
}) => {
  await page.goto("/budgets");
  await page.getByRole("button", { name: "Add Budget" }).click();
  const dialog = page.getByRole("dialog", { name: "Add Budget", exact: true });
  await dialog.getByLabel("Category").selectOption({ label: "Groceries" });
  await dialog.getByLabel("Monthly limit").fill("100");
  await page.route("**/_serverFn/**", async (route) => {
    if (route.request().method() === "POST") await route.abort();
    else await route.continue();
  });
  await dialog.getByRole("button", { name: "Create Budget" }).click();
  await expect(dialog.getByRole("alert")).toHaveText(
    "We could not save this budget. Refresh your budgets and try again.",
  );
  await expect(dialog.getByLabel("Monthly limit")).toHaveValue("100");
  await page.unroute("**/_serverFn/**");
  await dialog.getByRole("button", { name: "Create Budget" }).click();
  await expect(dialog).toBeHidden();
});

test("handles a budget created in another tab while the form is stale", async ({
  page,
  signedInUser: _user,
}) => {
  await page.goto("/budgets");
  const second = await page.context().newPage();
  try {
    await second.goto("/budgets");
    await second.getByRole("button", { name: "Add Budget" }).click();
    const staleForm = second.getByRole("dialog", { name: "Add Budget", exact: true });
    await staleForm.getByLabel("Category").selectOption({ label: "Groceries" });
    await staleForm.getByLabel("Monthly limit").fill("100");
    await createBudget(page, "Groceries");
    await staleForm.getByRole("button", { name: "Create Budget" }).click();
    await expect(staleForm.getByRole("alert")).toHaveText(
      "This category already has a budget. Refresh your budgets and try again.",
    );
    await staleForm.getByRole("button", { name: "Cancel" }).click();
    await expect(second.getByRole("article", { name: "Groceries", exact: true })).toHaveCount(1);
  } finally {
    await second.close();
  }
});

// Discover the generated RPC URL by its response fields, rather than hardcode
// build-specific TanStack function hashes. A seed budget makes it identifiable.
async function budgetRpcPath(page: Page) {
  const response = page.waitForResponse(
    async (response) =>
      response.url().includes("/_serverFn/") &&
      response.request().method() === "GET" &&
      (await response.text()).includes("spentMinor"),
  );
  await page.goto("/budgets");
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  return new URL((await response).url()).pathname;
}

test("handles loading and a fetch error with recovery", async ({ page, signedInUser: _user }) => {
  await page.request.post("/test-run-sweep?budgets=create", {
    data: { categoryName: "Groceries", limitMinor: 10000 },
  });
  const path = await budgetRpcPath(page);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`**${path}*`, async (route) => {
    await gate;
    await route.continue();
  });
  const navigation = page.goto("/budgets");
  try {
    await expect(page.getByRole("status")).toHaveText("Loading budgets...");
  } finally {
    release();
  }
  await navigation;
  await expect(page.getByRole("article", { name: "Groceries", exact: true })).toBeVisible();
  await page.unroute(`**${path}*`);
  await page.route(`**${path}*`, (route) => route.fulfill({ status: 503, body: "Unavailable" }));
  await page.goto("/budgets");
  await expect(page.getByRole("alert")).toContainText("We could not load your budgets.");
  await page.unroute(`**${path}*`);
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("article", { name: "Groceries", exact: true })).toBeVisible();
});

test("refetches budgets at the UTC month boundary", async ({ page, signedInUser: _user }) => {
  await page.request.post("/test-run-sweep?budgets=create", {
    data: { categoryName: "Groceries", limitMinor: 10000 },
  });
  const now = new Date();
  const boundary = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  await page.clock.install({ time: new Date(boundary - 1000) });
  const path = await budgetRpcPath(page);
  let requests = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === path) requests++;
  });
  await page.clock.fastForward(2000);
  await expect.poll(() => requests).toBeGreaterThan(0);
});
