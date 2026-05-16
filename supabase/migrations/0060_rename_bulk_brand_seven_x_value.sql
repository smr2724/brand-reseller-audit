-- Migration 0060: Rename bulk_run_brands.legion_score → brand_seven_x_value
-- The column stores seven_x_multiple_value (a dollar amount), not a 0-100 Legion Score.
-- The name `legion_score` is reserved elsewhere in the app for the 0-100 ranking score.
ALTER TABLE bulk_run_brands RENAME COLUMN legion_score TO brand_seven_x_value;
