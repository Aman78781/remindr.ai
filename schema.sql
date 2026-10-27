-- Future PostgreSQL/Supabase version of the two browser databases.
create table students (id uuid primary key default gen_random_uuid(), name text not null, school_email text unique not null, school_id text unique not null, whatsapp text not null check (whatsapp ~ '^\+[1-9][0-9]{7,14}$'), password_hash text not null, created_at timestamptz default now());
create table teachers (id uuid primary key default gen_random_uuid(), name text not null, school_email text unique not null, school_id text unique not null, whatsapp text not null check (whatsapp ~ '^\+[1-9][0-9]{7,14}$'), password_hash text not null, created_at timestamptz default now());
create table exams (id uuid primary key default gen_random_uuid(), teacher_id uuid references teachers(id) on delete cascade, title text not null, subject text not null, class_grade text not null, exam_at timestamptz not null, revision_notes text default '', created_at timestamptz default now());
create index exams_date_idx on exams(exam_at);
