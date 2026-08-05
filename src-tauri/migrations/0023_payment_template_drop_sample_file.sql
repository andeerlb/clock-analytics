-- The sample file was only ever a temporary aid for building the column
-- mapping in the wizard — once a template is saved, everything needed to
-- read a real file again lives in payment_template_groups/fields/rules.
-- Copying it into the app's data dir and reopening it on every edit was
-- pointless persistence of something with no ongoing purpose. Editing a
-- saved template now works directly off the saved configuration, with no
-- file involved at all.
ALTER TABLE payment_templates DROP COLUMN sample_file_path;
ALTER TABLE payment_templates DROP COLUMN sample_file_name;
