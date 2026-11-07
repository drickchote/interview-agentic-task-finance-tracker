ALTER TABLE "budget_notifications" ALTER COLUMN "spent_minor" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "budget_notifications" ADD COLUMN "email_from" text;--> statement-breakpoint
ALTER TABLE "budget_notifications" ADD COLUMN "email_subject" text;--> statement-breakpoint
ALTER TABLE "budget_notifications" ADD COLUMN "email_text" text;--> statement-breakpoint
ALTER TABLE "budget_notifications" ADD COLUMN "email_provider" text;--> statement-breakpoint
ALTER TABLE "budget_notifications" ADD COLUMN "first_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "budget_notifications" ADD COLUMN "last_error" text;