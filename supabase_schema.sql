-- ============================================================
-- 我的工作台 · Supabase 表结构
-- 使用方法：登录 Supabase Dashboard → SQL Editor → 粘贴本脚本 → Run
-- 适用于「不登录 / 单用户共享」模式：任何拿到 anon key 的人都能读写此表，
-- 仅适合个人非敏感数据。如需多用户隔离，请改用 Supabase Auth + 按 user_id 隔离。
-- 本脚本可重复运行（幂等）：建表用 IF NOT EXISTS、策略先 DROP 再建、加入
-- 发布前先判断表是否已是成员，避免重复执行报错导致事务回滚。
-- ============================================================

-- 1) 单文档整行同步表：整个工作台 state 存为一行 JSON
create table if not exists workbench_state (
  id          text primary key,          -- 固定值 'app'（单用户共享）
  data        jsonb not null,            -- 整个工作台数据
  updated_at  timestamptz default now()
);

-- 2) 授予匿名/已登录角色访问权限（Supabase 默认 anon key 对应 anon 角色）
grant all on table workbench_state to anon;
grant all on table workbench_state to authenticated;

-- 3) 开启行级安全，并用策略允许匿名角色完整读写
alter table workbench_state enable row level security;

drop policy if exists "anon_all" on workbench_state;
create policy "anon_all" on workbench_state
  for all to anon
  using (true) with check (true);

-- 4) 开启 Realtime，实现多设备实时同步
--    先判断发布是否存在、且表尚未加入，避免重复执行报 42710 导致整段事务回滚
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public'
         and tablename = 'workbench_state'
     ) then
    alter publication supabase_realtime add table workbench_state;
  end if;
end $$;

-- ============================================================
-- 5) 体重体脂记录表（与工作台主数据分开存储，按日期唯一）
--    字段：id / user_id / date / weight / body_fat / created_at
--    单用户共享模式：user_id 固定为 'shared'
-- ============================================================
create table if not exists body_metrics (
  id          uuid primary key default gen_random_uuid(),
  user_id     text not null default 'shared',
  date        text not null,                         -- 'YYYY-MM-DD'
  weight      numeric(5,1) not null,                 -- 体重 kg，1 位小数
  body_fat    numeric(5,1) not null,                 -- 体脂率 %，1 位小数
  created_at  timestamptz default now()
);

-- 同一天只能有一条记录（重复录入由应用层确认后覆盖）
create unique index if not exists body_metrics_uidx on body_metrics (user_id, date);

grant all on table body_metrics to anon;
grant all on table body_metrics to authenticated;

alter table body_metrics enable row level security;

drop policy if exists "bm_shared_select" on body_metrics;
create policy "bm_shared_select" on body_metrics for select to anon using (user_id='shared');
drop policy if exists "bm_shared_insert" on body_metrics;
create policy "bm_shared_insert" on body_metrics for insert to anon with check (user_id='shared');
drop policy if exists "bm_shared_update" on body_metrics;
create policy "bm_shared_update" on body_metrics for update to anon using (user_id='shared') with check (user_id='shared');
drop policy if exists "bm_shared_delete" on body_metrics;
create policy "bm_shared_delete" on body_metrics for delete to anon using (user_id='shared');

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public'
         and tablename = 'body_metrics'
     ) then
    alter publication supabase_realtime add table body_metrics;
  end if;
end $$;

-- 6) 强制刷新 PostgREST schema 缓存，确保新建的 body_metrics 立即被 API 识别
--    （否则可能出现"table not found in schema cache"，需手动刷新缓存）
notify pgrst, 'reload schema';
