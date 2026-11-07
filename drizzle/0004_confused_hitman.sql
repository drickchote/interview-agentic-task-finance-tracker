CREATE TYPE "public"."budget_notification_status" AS ENUM('pending', 'processing', 'sent', 'failed');--> statement-breakpoint
CREATE TABLE "budget_notifications" (
	"id" text PRIMARY KEY NOT NULL,
	"budget_id" text NOT NULL,
	"month" text NOT NULL,
	"recipient_email" text NOT NULL,
	"limit_minor" integer NOT NULL,
	"spent_minor" integer NOT NULL,
	"delivery_idempotency_key" text GENERATED ALWAYS AS ('budget-alert:' || "budget_id" || ':' || "month") STORED NOT NULL,
	"status" "budget_notification_status" DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_retry_at" timestamp with time zone,
	"processing_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "budget_notifications_budget_month_unique" UNIQUE("budget_id","month"),
	CONSTRAINT "budget_notifications_delivery_key_unique" UNIQUE("delivery_idempotency_key"),
	CONSTRAINT "budget_notifications_month_format" CHECK ("budget_notifications"."month" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$' AND left("budget_notifications"."month", 4) <> '0000'),
	CONSTRAINT "budget_notifications_limit_positive" CHECK ("budget_notifications"."limit_minor" > 0),
	CONSTRAINT "budget_notifications_spent_nonnegative" CHECK ("budget_notifications"."spent_minor" >= 0),
	CONSTRAINT "budget_notifications_attempt_count_nonnegative" CHECK ("budget_notifications"."attempt_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "budgets" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"category_id" text NOT NULL,
	"limit_minor" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "budgets_user_category_unique" UNIQUE("user_id","category_id"),
	CONSTRAINT "budgets_limit_positive" CHECK ("budgets"."limit_minor" > 0)
);
--> statement-breakpoint
ALTER TABLE "budget_notifications" ADD CONSTRAINT "budget_notifications_budget_id_budgets_id_fk" FOREIGN KEY ("budget_id") REFERENCES "public"."budgets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "budget_notifications_retry_idx" ON "budget_notifications" USING btree ("status","next_retry_at");