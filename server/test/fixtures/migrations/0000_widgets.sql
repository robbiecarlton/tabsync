CREATE TABLE "widgets" (
	"id" text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE INDEX "widgets_id_idx" ON "widgets" ("id");
