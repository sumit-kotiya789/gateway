CREATE TABLE "team_invites" (
	"id" uuid PRIMARY KEY NOT NULL,
	"merchant_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" "merchant_role" NOT NULL,
	"token_hash" text NOT NULL,
	"invited_by" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "team_invites_closed_once" CHECK ("team_invites"."accepted_at" is null or "team_invites"."revoked_at" is null)
);
--> statement-breakpoint
ALTER TABLE "merchant_users" ADD COLUMN "removed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "team_invites" ADD CONSTRAINT "team_invites_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_invites" ADD CONSTRAINT "team_invites_invited_by_merchant_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."merchant_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "team_invites_token_uq" ON "team_invites" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "team_invites_open_uq" ON "team_invites" USING btree ("merchant_id",lower("email")) WHERE "team_invites"."accepted_at" is null and "team_invites"."revoked_at" is null;