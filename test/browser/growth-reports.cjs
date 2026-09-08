// Run after compilation with Playwright on NODE_PATH and CHROMIUM_PATH set if needed.
// The isolated project and screenshots are retained at the printed artifact path.
const fs=require('fs'),path=require('path'),assert=require('assert/strict'),vm=require('vm');
const {chromium}=require('playwright');
const root=path.resolve(__dirname, '../..');
const base=fs.mkdtempSync(path.join(require('os').tmpdir(), 'solomap-report-browser-'));
const project=path.join(base, 'project');
(async()=>{
 fs.mkdirSync(path.join(project,'src'),{recursive:true});
 for(let i=0;i<12;i++){const dir=path.join(project,'src',`module${i}WithLongNameThatMustRemainReadable`);fs.mkdirSync(dir);fs.writeFileSync(path.join(dir,'index.js'),'export const result = true;\n');}
 const {registerLearningTask,writeLearningJson}=require(path.join(root,'out/taskReport.js'));
 const runDir=path.join(project,'.solopreneur/agent-runs/__solo__/1');
 const taskId=registerLearningTask(project,{executionLogId:1,runDir,userMessage:'原始需求必须按需查看。'.repeat(100),startedAt:'2026-09-08'});
 const body={summary:'导出可以按日期筛选，用户只需保存想要的内容。',unmetRequirements:['仍需确认导出时默认选择的日期。'],decisions:['保留用户选择。'],corrections:[],verification:['过程日志只在按需查看时显示。'.repeat(40)],commits:[],experienceUsage:[],lessons:[]};
 const legacySummary='长过程说明。'.repeat(200);
 for(let i=1;i<=2;i++)writeLearningJson(path.join(runDir,`task-report-${i}.json`),{schemaVersion:1,projectPath:project,taskId,executionLogId:1,turnId:`${i}:complete`,createdAt:`2026-09-0${i}`,report:{...body,summary:i===2?legacySummary:body.summary}});
 await require(path.join(root,'out/projectGrowth.js')).refreshProjectGrowthSnapshot(project,root,{scanReason:'browser-regression'});
 const view=await require(path.join(root,'out/projectGrowth.js')).getProjectGrowthView(project,root,{refreshIfMissing:false});
 const {queryGrowthReports}=require(path.join(root,'out/growthReports.js'));
 const tasks=await queryGrowthReports(project,root,{});const task=tasks.tasks[0];assert.ok(task);
 const turns=await queryGrowthReports(project,root,{taskId:task.taskId});
 const html=require(path.join(root,'out/projectGrowthWebview.js')).getProjectGrowthWebviewHtml({cspSource:'self',asWebviewUri:u=>u},{extensionUri:{fsPath:root}},view,'SoloMap',true,[{name:'SoloMap',path:project}]);
 for(const m of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g))new vm.Script(m[1]);
 fs.writeFileSync(path.join(base,'growth.html'),html);
 const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH || '/usr/bin/chromium',headless:true});
 try {
 const page=await browser.newPage();const errors=[],actions=[];page.on('pageerror',e=>errors.push(e.message));
 await page.exposeFunction('bridge',async m=>{actions.push(m);if(m.command==='growth.reports')await page.evaluate(d=>window.postMessage(d,'*'),{command:'growth.reportsLoaded',projectPath:project,requestId:m.requestId,page:tasks});if(m.command==='growth.reportTurns')await page.evaluate(d=>window.postMessage(d,'*'),{command:'growth.reportTurnsLoaded',projectPath:project,requestId:m.requestId,taskId:task.taskId,page:turns});});
 await page.evaluate(()=>{let state={};window.acquireVsCodeApi=()=>({getState:()=>state,setState:s=>state=s,postMessage:m=>window.bridge(m)});});await page.setContent(html);await page.locator('.report-task').waitFor();
 const failures=[],check=(ok,msg)=>{if(!ok)failures.push(msg);};
 check(await page.locator('.module-card').count() >= 12, 'exercise dense long module names');
 check(!(await page.locator('.report-title').innerText()).includes('原始需求必须按需查看'),'task heading contains full original instructions');
 const visibleSummary=await page.locator('.report-result').innerText();
 check(Array.from(visibleSummary).length<=120 && visibleSummary!==legacySummary,'legacy summary is not condensed in the default layer');
 await page.getByRole('button',{name:'继续处理',exact:true,includeHidden:true}).first().waitFor({state:'attached'});
 check(await page.getByRole('button',{name:'继续处理',exact:true}).first().isVisible(),'latest result is not immediately actionable');
 check(!await page.getByText('关键决策',{exact:true}).first().isVisible(),'process fields are visible by default');
 for(const width of [320,390,600,900,1440]){
 await page.setViewportSize({width,height:900});await page.locator('[data-module-details]').evaluateAll(ns=>ns.forEach(n=>n.open=true));
 const measurements=await page.evaluate(()=>{const panel=document.querySelector('#growth-reports').parentElement,r=panel.getBoundingClientRect(),before=panel.previousElementSibling.getBoundingClientRect(),after=panel.nextElementSibling.getBoundingClientRect();const clipped=[];for(const c of document.querySelectorAll('.module-card')){const b=c.getBoundingClientRect();for(const e of c.querySelectorAll('.module-title,.signal-tag,.module-facts,button,details,p')){const x=e.getBoundingClientRect();if(x.width && (x.right>b.right+1||x.left<b.left-1||x.bottom>b.bottom+1))clipped.push(e.textContent);}}return {gaps:[r.top-before.bottom,after.top-r.bottom],clipped};});
 check(measurements.gaps.every(n=>n>=20),`${width}px report gaps ${measurements.gaps}`);check(!measurements.clipped.length,`${width}px clipped module content: ${measurements.clipped.join(',')}`);
 if(width===390||width===1440){await page.locator('#growth-reports').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(base,`reports-${width}.png`)});await page.locator('.module-matrix').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(base,`modules-${width}.png`)});}
 }
 await page.getByRole('button',{name:'继续处理',exact:true}).click();
 const continued=actions.filter(m=>m.command==='growth.reportAction');
 check(continued.length===1 && continued[0].kind==='continue' && continued[0].taskId===task.taskId && continued[0].executionLogId===1 && continued[0].turnId==='2:complete', 'continue must target the latest original turn');
 await page.getByText('产出与依据',{exact:true}).first().click();
 check(await page.getByText('关键决策',{exact:true}).first().isVisible(),'evidence must remain available on request');
 check(await page.getByText(legacySummary,{exact:true}).isVisible(),'full legacy summary must remain available on request');
 await page.getByText('较早汇报',{exact:true}).click();
 check(await page.getByText('第1轮汇报',{exact:false}).isVisible(),'older reports must remain accessible');
 check(!errors.length,`script errors ${errors}`);check(actions.every(m=>['growth.reports','growth.reportTurns','growth.reportAction'].includes(m.command)),`unexpected effects ${actions.map(m=>m.command)}`);
 fs.writeFileSync(path.join(base,'ui-result.json'),JSON.stringify({failures,errors,requests:actions.map(m=>m.command)},null,2));console.log({artifacts:base,failures});assert.equal(failures.length,0);
 } finally { await browser.close(); }
})().catch(e=>{console.error(e);process.exitCode=1});
