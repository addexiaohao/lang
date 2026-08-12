


SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE EXTENSION IF NOT EXISTS "pg_stat_statements" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "supabase_vault" WITH SCHEMA "vault";






CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA "extensions";






CREATE OR REPLACE FUNCTION "public"."handle_new_user"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  insert into public.user_settings (user_id)
  values (new.id)
  on conflict (user_id) do nothing;
  return new;
end;
$$;


ALTER FUNCTION "public"."handle_new_user"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."rls_auto_enable"() RETURNS "event_trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog'
    AS $$
DECLARE
  cmd record;
BEGIN
  FOR cmd IN
    SELECT *
    FROM pg_event_trigger_ddl_commands()
    WHERE command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      AND object_type IN ('table','partitioned table')
  LOOP
     IF cmd.schema_name IS NOT NULL AND cmd.schema_name IN ('public') AND cmd.schema_name NOT IN ('pg_catalog','information_schema') AND cmd.schema_name NOT LIKE 'pg_toast%' AND cmd.schema_name NOT LIKE 'pg_temp%' THEN
      BEGIN
        EXECUTE format('alter table if exists %s enable row level security', cmd.object_identity);
        RAISE LOG 'rls_auto_enable: enabled RLS on %', cmd.object_identity;
      EXCEPTION
        WHEN OTHERS THEN
          RAISE LOG 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
      END;
     ELSE
        RAISE LOG 'rls_auto_enable: skip % (either system schema or not in enforced list: %.)', cmd.object_identity, cmd.schema_name;
     END IF;
  END LOOP;
END;
$$;


ALTER FUNCTION "public"."rls_auto_enable"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."save_card_and_link"("card" "jsonb", "link" "jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql"
    AS $$
declare
  new_card knowledge_cards;
begin
  insert into knowledge_cards (kind, name, details, tags, related_card_ids, related_table_ids, skill, importance, project_id)
  select kind, name, details, tags, related_card_ids, related_table_ids, skill, importance, project_id
  from jsonb_populate_record(null::knowledge_cards, card)
  returning * into new_card;

  insert into source_knowledge (source_id, knowledge_card_id, positions, note)
  values (
    (link->>'source_id')::uuid,
    new_card.id,
    (link->'positions'),
    link->>'note'
  );

  return to_jsonb(new_card);
end;
$$;


ALTER FUNCTION "public"."save_card_and_link"("card" "jsonb", "link" "jsonb") OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."contexts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "project_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "description" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."contexts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."knowledge_cards" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "project_id" "uuid",
    "kind" "text" NOT NULL,
    "name" "text" NOT NULL,
    "details" "jsonb",
    "tags" "text"[],
    "related_card_ids" "uuid"[],
    "related_table_ids" "uuid"[] DEFAULT '{}'::"uuid"[],
    "skill" integer,
    "importance" integer,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "knowledge_cards_importance_check" CHECK ((("importance" >= 1) AND ("importance" <= 10))),
    CONSTRAINT "knowledge_cards_kind_check" CHECK (("kind" = ANY (ARRAY['vocabulary'::"text", 'grammar'::"text", 'expression'::"text"]))),
    CONSTRAINT "knowledge_cards_skill_check" CHECK ((("skill" >= 1) AND ("skill" <= 10)))
);


ALTER TABLE "public"."knowledge_cards" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."projects" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "system_prompt" "text",
    "config" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "user_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "tts_locale" "text",
    "context_required" boolean DEFAULT false NOT NULL
);


ALTER TABLE "public"."projects" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."source_knowledge" (
    "source_id" "uuid" NOT NULL,
    "knowledge_card_id" "uuid" NOT NULL,
    "positions" "jsonb" NOT NULL,
    "note" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."source_knowledge" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."source_table_cells" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "source_id" "uuid" NOT NULL,
    "table_cell_id" "uuid" NOT NULL,
    "excerpt" "text",
    "note" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."source_table_cells" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."sources" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "project_id" "uuid" NOT NULL,
    "user_id" "uuid",
    "context_id" "uuid",
    "original_text" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."sources" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."system_prompt_history" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "project_id" "uuid" NOT NULL,
    "prompt" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."system_prompt_history" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."table_cells" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "table_id" "uuid" NOT NULL,
    "cell_key" "text" NOT NULL,
    "axis_values" "jsonb" NOT NULL,
    "skill" smallint,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "table_cells_skill_check" CHECK ((("skill" >= 0) AND ("skill" <= 10)))
);


ALTER TABLE "public"."table_cells" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."tables" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "project_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "axes" "jsonb" NOT NULL,
    "axis_values" "jsonb" NOT NULL,
    "tags" "text"[] DEFAULT '{}'::"text"[],
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."tables" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."tags" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "project_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "display_name" "text",
    "description" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."tags" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."user_settings" (
    "user_id" "uuid" NOT NULL,
    "default_project_id" "uuid",
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."user_settings" OWNER TO "postgres";


ALTER TABLE ONLY "public"."contexts"
    ADD CONSTRAINT "contexts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."knowledge_cards"
    ADD CONSTRAINT "knowledge_cards_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."knowledge_cards"
    ADD CONSTRAINT "knowledge_cards_project_id_name_key" UNIQUE ("project_id", "name");



ALTER TABLE ONLY "public"."projects"
    ADD CONSTRAINT "projects_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."source_knowledge"
    ADD CONSTRAINT "source_knowledge_pkey" PRIMARY KEY ("source_id", "knowledge_card_id");



ALTER TABLE ONLY "public"."source_table_cells"
    ADD CONSTRAINT "source_table_cells_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."sources"
    ADD CONSTRAINT "sources_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."system_prompt_history"
    ADD CONSTRAINT "system_prompt_history_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."table_cells"
    ADD CONSTRAINT "table_cells_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."table_cells"
    ADD CONSTRAINT "table_cells_table_id_cell_key_key" UNIQUE ("table_id", "cell_key");



ALTER TABLE ONLY "public"."tables"
    ADD CONSTRAINT "tables_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."tables"
    ADD CONSTRAINT "tables_project_id_name_key" UNIQUE ("project_id", "name");



ALTER TABLE ONLY "public"."tags"
    ADD CONSTRAINT "tags_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."tags"
    ADD CONSTRAINT "tags_project_id_name_key" UNIQUE ("project_id", "name");



ALTER TABLE ONLY "public"."user_settings"
    ADD CONSTRAINT "user_settings_pkey" PRIMARY KEY ("user_id");



CREATE INDEX "idx_contexts_project_id" ON "public"."contexts" USING "btree" ("project_id");



CREATE INDEX "idx_knowledge_cards_project_id" ON "public"."knowledge_cards" USING "btree" ("project_id");



CREATE INDEX "idx_projects_user_id" ON "public"."projects" USING "btree" ("user_id");



CREATE INDEX "idx_sources_project_id" ON "public"."sources" USING "btree" ("project_id");



CREATE INDEX "idx_sources_user_id" ON "public"."sources" USING "btree" ("user_id");



CREATE INDEX "idx_stc_cell" ON "public"."source_table_cells" USING "btree" ("table_cell_id");



CREATE INDEX "idx_stc_source" ON "public"."source_table_cells" USING "btree" ("source_id");



CREATE INDEX "idx_system_prompt_history_project_id" ON "public"."system_prompt_history" USING "btree" ("project_id");



CREATE INDEX "idx_table_cells_table" ON "public"."table_cells" USING "btree" ("table_id");



CREATE INDEX "idx_tables_project_id" ON "public"."tables" USING "btree" ("project_id");



CREATE INDEX "idx_tags_project_id" ON "public"."tags" USING "btree" ("project_id");



ALTER TABLE ONLY "public"."contexts"
    ADD CONSTRAINT "contexts_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id");



ALTER TABLE ONLY "public"."knowledge_cards"
    ADD CONSTRAINT "knowledge_cards_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."projects"
    ADD CONSTRAINT "projects_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."source_knowledge"
    ADD CONSTRAINT "source_knowledge_knowledge_card_id_fkey" FOREIGN KEY ("knowledge_card_id") REFERENCES "public"."knowledge_cards"("id");



ALTER TABLE ONLY "public"."source_knowledge"
    ADD CONSTRAINT "source_knowledge_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id");



ALTER TABLE ONLY "public"."source_table_cells"
    ADD CONSTRAINT "source_table_cells_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."source_table_cells"
    ADD CONSTRAINT "source_table_cells_table_cell_id_fkey" FOREIGN KEY ("table_cell_id") REFERENCES "public"."table_cells"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."sources"
    ADD CONSTRAINT "sources_context_id_fkey" FOREIGN KEY ("context_id") REFERENCES "public"."contexts"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."sources"
    ADD CONSTRAINT "sources_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id");



ALTER TABLE ONLY "public"."sources"
    ADD CONSTRAINT "sources_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."system_prompt_history"
    ADD CONSTRAINT "system_prompt_history_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."table_cells"
    ADD CONSTRAINT "table_cells_table_id_fkey" FOREIGN KEY ("table_id") REFERENCES "public"."tables"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."tables"
    ADD CONSTRAINT "tables_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."tags"
    ADD CONSTRAINT "tags_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_settings"
    ADD CONSTRAINT "user_settings_default_project_id_fkey" FOREIGN KEY ("default_project_id") REFERENCES "public"."projects"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."user_settings"
    ADD CONSTRAINT "user_settings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE "public"."contexts" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."knowledge_cards" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."projects" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."source_knowledge" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."source_table_cells" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."sources" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."system_prompt_history" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."table_cells" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."tables" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."tags" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."user_settings" ENABLE ROW LEVEL SECURITY;




ALTER PUBLICATION "supabase_realtime" OWNER TO "postgres";


GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";






















































































































































GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "anon";
GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "service_role";



GRANT ALL ON FUNCTION "public"."rls_auto_enable"() TO "anon";
GRANT ALL ON FUNCTION "public"."rls_auto_enable"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."rls_auto_enable"() TO "service_role";



GRANT ALL ON FUNCTION "public"."save_card_and_link"("card" "jsonb", "link" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."save_card_and_link"("card" "jsonb", "link" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."save_card_and_link"("card" "jsonb", "link" "jsonb") TO "service_role";


















GRANT ALL ON TABLE "public"."contexts" TO "anon";
GRANT ALL ON TABLE "public"."contexts" TO "authenticated";
GRANT ALL ON TABLE "public"."contexts" TO "service_role";



GRANT ALL ON TABLE "public"."knowledge_cards" TO "anon";
GRANT ALL ON TABLE "public"."knowledge_cards" TO "authenticated";
GRANT ALL ON TABLE "public"."knowledge_cards" TO "service_role";



GRANT ALL ON TABLE "public"."projects" TO "anon";
GRANT ALL ON TABLE "public"."projects" TO "authenticated";
GRANT ALL ON TABLE "public"."projects" TO "service_role";



GRANT ALL ON TABLE "public"."source_knowledge" TO "anon";
GRANT ALL ON TABLE "public"."source_knowledge" TO "authenticated";
GRANT ALL ON TABLE "public"."source_knowledge" TO "service_role";



GRANT ALL ON TABLE "public"."source_table_cells" TO "anon";
GRANT ALL ON TABLE "public"."source_table_cells" TO "authenticated";
GRANT ALL ON TABLE "public"."source_table_cells" TO "service_role";



GRANT ALL ON TABLE "public"."sources" TO "anon";
GRANT ALL ON TABLE "public"."sources" TO "authenticated";
GRANT ALL ON TABLE "public"."sources" TO "service_role";



GRANT ALL ON TABLE "public"."system_prompt_history" TO "anon";
GRANT ALL ON TABLE "public"."system_prompt_history" TO "authenticated";
GRANT ALL ON TABLE "public"."system_prompt_history" TO "service_role";



GRANT ALL ON TABLE "public"."table_cells" TO "anon";
GRANT ALL ON TABLE "public"."table_cells" TO "authenticated";
GRANT ALL ON TABLE "public"."table_cells" TO "service_role";



GRANT ALL ON TABLE "public"."tables" TO "anon";
GRANT ALL ON TABLE "public"."tables" TO "authenticated";
GRANT ALL ON TABLE "public"."tables" TO "service_role";



GRANT ALL ON TABLE "public"."tags" TO "anon";
GRANT ALL ON TABLE "public"."tags" TO "authenticated";
GRANT ALL ON TABLE "public"."tags" TO "service_role";



GRANT ALL ON TABLE "public"."user_settings" TO "anon";
GRANT ALL ON TABLE "public"."user_settings" TO "authenticated";
GRANT ALL ON TABLE "public"."user_settings" TO "service_role";









ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";



































