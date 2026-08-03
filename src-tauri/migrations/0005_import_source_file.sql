-- Links each import back to the whole original file it came from, so the UI
-- can offer "ver arquivo original" (the whole batch, for multi-page files)
-- separately from the employee's own split-off page.
ALTER TABLE imports ADD COLUMN source_file_id INTEGER REFERENCES source_files(id);
