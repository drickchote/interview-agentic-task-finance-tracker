import { test, expect, type Page } from "./fixtures";

async function addExpense(page: Page, amount: string, category = "Groceries") {
  await page.getByRole("banner").getByRole("button", { name: "Add Transaction" }).click();
  const dialog = page.getByRole("dialog", { name: "New Transaction" });
  await dialog.getByLabel("Date").fill(new Date().toISOString().slice(0, 10) + "T12:00");
  await dialog.getByLabel("Description").fill("Budget expense " + crypto.randomUUID());
  await dialog.getByRole("spinbutton", { name: "Amount", exact: true }).fill(amount);
  await dialog.getByLabel("Account").selectOption({ label: "Main (PLN)" });
  await dialog.getByLabel("Category").selectOption({ label: category });
  await dialog.getByRole("button", { name: "Create Transaction" }).click();
  await expect(dialog).toBeHidden();
}

async function createBudget(page: Page, limitMinor: number) {
  const response = await page.request.post("/test-run-sweep?budgets=create", {
    data: { categoryName: "Groceries", limitMinor },
  });
  expect(response.ok()).toBe(true);
  const result = await response.json();
  expect(result.success).toBe(true);
  return result.data.id as string;
}

async function emails(page: Page, username: string) {
  const processed = await page.request.post("/test-run-sweep?budgets=process");
  expect(processed.ok()).toBe(true);
  const response = await page.request.get(`/test-emails?to=${username}@example.com`);
  return (await response.json()).emails as Array<{ subject: string; text: string }>;
}

test("transaction expenses trigger only above the limit and send once per month", async ({
  page,
  signedInUser,
}) => {
  await createBudget(page, 10000);
  await page.goto("/transactions");
  await addExpense(page, "100.00");
  expect(await emails(page, signedInUser.username)).toHaveLength(0);
  await addExpense(page, "0.01");
  const sent = await emails(page, signedInUser.username);
  expect(sent).toHaveLength(1);
  expect(sent[0].text).toContain("100.01");
  await addExpense(page, "50.00");
  expect(await emails(page, signedInUser.username)).toHaveLength(1);
});

test("creating an exceeded budget and lowering its limit keep the original alert content", async ({
  page,
  signedInUser,
}) => {
  await page.goto("/transactions");
  await addExpense(page, "20.00");
  const id = await createBudget(page, 1000);
  const response = await page.request.post("/test-run-sweep?budgets=limit", {
    data: { id, limitMinor: 500 },
  });
  expect((await response.json()).success).toBe(true);
  const sent = await emails(page, signedInUser.username);
  expect(sent).toHaveLength(1);
  expect(sent[0].text).toContain("Monthly limit: 10.00");
  expect(sent[0].text).toContain("Spending: 20.00");
});

test("CSV imports queue one alert using the whole persisted batch", async ({
  page,
  signedInUser,
}) => {
  await createBudget(page, 100);
  const date = new Date().toISOString().slice(0, 10);
  await page.goto("/import");
  await page.getByTestId("file-input").setInputFiles({
    name: "budget-batch.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(
      `Date,Amount,Description,Category\n${date},-2.00,Budget one,Groceries\n${date},-3.00,Budget two,Groceries\n`,
    ),
  });
  await page.getByTestId("continue-to-account").click();
  await page.getByRole("combobox", { name: "Account" }).selectOption({ label: "Main (PLN)" });
  await page.getByTestId("continue-to-preview").click();
  await page.getByRole("button", { name: "Confirm Import" }).click();
  await expect(page.getByTestId("import-summary")).toBeVisible();
  const sent = await emails(page, signedInUser.username);
  expect(sent).toHaveLength(1);
  expect(sent[0].text).toContain("Spending: 5.00");
});

test("moving a category under a budgeted parent triggers the parent alert", async ({
  page,
  signedInUser,
}) => {
  await createBudget(page, 1000);
  await page.goto("/transactions");
  await addExpense(page, "20.00", "Transport");
  expect(await emails(page, signedInUser.username)).toHaveLength(0);
  await page.goto("/categories");
  const row = page.getByRole("row").filter({ has: page.getByText("Transport", { exact: true }) });
  await row.getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByLabel("Parent Category").selectOption({ label: "Groceries" });
  await page.getByRole("button", { name: "Save Changes" }).click();
  await expect(page.getByRole("heading", { name: "Edit", exact: true })).toBeHidden();
  const sent = await emails(page, signedInUser.username);
  expect(sent).toHaveLength(1);
  expect(sent[0].text).toContain("Spending: 20.00");
});

test("receipt-created expenses trigger alerts using the transaction category", async ({
  page,
  signedInUser,
}) => {
  await createBudget(page, 1000);
  await page.goto("/receipts/scan");
  await page.getByTestId("file-input").setInputFiles("tests/e2e/fixtures/images/receipt-test.png");
  await expect(page.getByTestId("store-name-input")).toHaveValue("FAKE_STORE");
  await page.getByTestId("date-input").fill(new Date().toISOString().slice(0, 10));
  await page.getByTestId("parent-category-select").selectOption({ label: "Groceries" });
  await page.getByTestId("account-select").selectOption({ label: "Main" });
  await page.getByTestId("save-receipt-btn").click();
  await expect(page.getByText("Receipt saved successfully!")).toBeVisible();
  const sent = await emails(page, signedInUser.username);
  expect(sent).toHaveLength(1);
  expect(sent[0].text).toContain("Spending: 36.99");
});

for (const mode of ["apply-rule", "recategorize"] as const) {
  test(`${mode} queues an alert after moving existing spending into a budget`, async ({
    page,
    signedInUser,
  }) => {
    await createBudget(page, 1000);
    await page.goto("/transactions");
    await addExpense(page, "20.00", "Transport");
    expect(await emails(page, signedInUser.username)).toHaveLength(0);
    if (mode === "recategorize") {
      const response = await page.request.post("/test-add-rule", {
        data: { pattern: "Budget expense", categoryName: "Groceries" },
      });
      expect(response.ok()).toBe(true);
      await page.goto("/categorization");
      await page.getByTestId("re-categorize-btn").click();
      await page.getByTestId("recat-mode-overwrite").check();
      await page.getByTestId("recategorize-run").click();
      await expect(page.getByTestId("recategorize-result")).toBeVisible();
    } else {
      await page.goto("/categorization");
      await page.getByTestId("add-rule").click();
      await page.getByTestId("rule-pattern").fill("Budget expense");
      await page.getByRole("combobox", { name: "Category" }).selectOption({ label: "Groceries" });
      await page.getByTestId("rule-save").click();
      await page.getByTestId("impact-overwrite").click();
      await expect(page.getByTestId("rule-form")).toBeHidden();
    }
    const sent = await emails(page, signedInUser.username);
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain("Spending: 20.00");
  });
}

test("deleting a category removes its budget and queued alert", async ({ page, signedInUser }) => {
  await createBudget(page, 1000);
  await page.goto("/transactions");
  await addExpense(page, "20.00");
  await page.goto("/categories");
  const row = page.getByRole("row").filter({ has: page.getByText("Groceries", { exact: true }) });
  await row.getByRole("button", { name: "Delete", exact: true }).click();
  const dialog = page.getByRole("alertdialog", { name: "Delete Category" });
  await dialog.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("main").getByText("Groceries", { exact: true })).toBeHidden();
  expect(await emails(page, signedInUser.username)).toHaveLength(0);
});
