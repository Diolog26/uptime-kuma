// Diolog fork: settings for the real-browser monitor's AI visual check (server/diolog/visual-check.js).
exports.up = async (knex) => {
    await knex.schema.alterTable("monitor", (table) => {
        table.boolean("ai_visual_check").notNullable().defaultTo(false);
        table.text("ai_visual_prompt");
    });
};

exports.down = async (knex) => {
    await knex.schema.alterTable("monitor", (table) => {
        table.dropColumn("ai_visual_check");
        table.dropColumn("ai_visual_prompt");
    });
};
