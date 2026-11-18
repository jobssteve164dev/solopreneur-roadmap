const {canonicalJson:canonical}=require('../../out/contentReferences.js');
const native={
    beginProjectGrowthRefreshStage(projectId, input) {
        if (!input.requestId.trim() || !Number.isInteger(input.generation) || input.generation < 1
            || !/^[a-f0-9-]{36}$/.test(input.manifest.stageId) || input.manifest.snapshot.projectPath === '')
            throw new Error('invalid_growth_refresh_stage');
        this.ensureProjectGrowthStageTables();
        this.transaction(() => {
            this.db.run('DELETE FROM runtime_growth_refresh_stage_items WHERE stage_id=?', [input.manifest.stageId]);
            this.db.run('DELETE FROM runtime_growth_refresh_stages WHERE stage_id=?', [input.manifest.stageId]);
            this.db.run('INSERT INTO runtime_growth_refresh_stages VALUES(?,?,?,?,?)', [input.manifest.stageId, projectId, input.requestId, input.generation, canonical(input.manifest)]);
        });
    },
    appendProjectGrowthRefreshStage(stageId, section, offset, items) {
        if (!/^[a-f0-9-]{36}$/.test(stageId) || !['nodes', 'edges', 'signals', 'labels'].includes(section)
            || !Number.isInteger(offset) || offset < 0 || !Array.isArray(items) || items.length < 1 || items.length > 200)
            throw new Error('invalid_growth_refresh_stage_page');
        this.ensureProjectGrowthStageTables();
        if (!this.rows('SELECT 1 FROM runtime_growth_refresh_stages WHERE stage_id=?', [stageId])[0])
            throw new Error('growth_refresh_stage_missing');
        this.transaction(() => items.forEach((item, index) => {
            this.db.run('INSERT INTO runtime_growth_refresh_stage_items VALUES(?,?,?,?)', [stageId, section, offset + index, canonical(item)]);
        }));
    },
    discardProjectGrowthRefreshStage(stageId) {
        this.ensureProjectGrowthStageTables();
        this.transaction(() => {
            this.db.run('DELETE FROM runtime_growth_refresh_stage_items WHERE stage_id=?', [stageId]);
            this.db.run('DELETE FROM runtime_growth_refresh_stages WHERE stage_id=?', [stageId]);
        });
    }
};
module.exports={nativeGrowthInput:(store,method,...args)=>native[method].apply(store,args),native};
