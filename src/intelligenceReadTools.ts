export type IntelligenceReadToolName = 'list_projects' | 'get_current_project' | 'get_plugin_settings' | 'get_today_review';

export interface IntelligenceReadToolSource {
  getProjects(): Array<{ name: string; path: string; priority?: string; description?: string }> | Promise<Array<{ name: string; path: string; priority?: string; description?: string }>>;
  getSelectedProjectPath(): string;
  getCurrentSteps(): Array<{ title: string; status: string }> | null | Promise<Array<{ title: string; status: string }> | null>;
  getSettings(): { language: string; cognitiveAgent?: string; cognitiveModel?: string };
  getTodayReview?(): { summary: string; items: string[] } | null | Promise<{ summary: string; items: string[] } | null>;
}

export interface IntelligenceReadTools {
  call(name: string): Promise<unknown>;
}

export interface IntelligenceProjectContext {
  selectedProject: string;
  projects: Array<{ name: string; priority?: string; description?: string }>;
  today?: { summary: string; items: string[] };
  currentSteps?: Array<{ title: string; status: string }>;
}

type IntelligenceRoadmapOperation = (operation: 'read_roadmap' | 'accept_roadmap_csv', input: { root: string }) => Promise<unknown>;

export async function readIntelligenceCurrentSteps(root: string, operation: IntelligenceRoadmapOperation): Promise<Array<{ title: string; status: string }>> {
  const read = async (name: 'read_roadmap' | 'accept_roadmap_csv') => {
    const roadmap = await operation(name, { root }) as { nodes: Array<{ title: string; status: string }> };
    return roadmap.nodes.map(node => ({ title: node.title, status: node.status }));
  };
  try { return await read('read_roadmap'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT' || error instanceof Error && /\bENOENT\b/.test(error.message)) return [];
    if (!(error instanceof Error) || error.message !== 'roadmap_import_required') throw error;
    try { return await read('accept_roadmap_csv'); }
    catch (acceptError) {
      const code = (acceptError as NodeJS.ErrnoException)?.code;
      if (code === 'ENOENT' || (acceptError instanceof Error && /\bENOENT\b/.test(acceptError.message))) return [];
      throw acceptError;
    }
  }
}

export async function buildIntelligenceProjectContext(source: IntelligenceReadToolSource): Promise<IntelligenceProjectContext> {
  const projects = await source.getProjects();
  const selectedProject = projects.find(project => project.path === source.getSelectedProjectPath());
  const today = await source.getTodayReview?.();
  const currentSteps = await source.getCurrentSteps();
  return {
    selectedProject: selectedProject?.name || '',
    projects: projects.map(project => ({
      name: String(project.name),
      ...(project.priority ? { priority: String(project.priority) } : {}),
      ...(project.description ? { description: String(project.description).slice(0, 500) } : {})
    })),
    ...(today ? { today: {
      summary: String(today.summary || '').slice(0, 500),
      items: (today.items || []).map(item => String(item).slice(0, 200)).slice(0, 10)
    } } : {}),
    ...(currentSteps === null ? {} : { currentSteps: currentSteps.map(step => ({
      title: String(step.title).slice(0, 200), status: String(step.status).slice(0, 100)
    })) })
  };
}

export function createIntelligenceReadTools(source: IntelligenceReadToolSource): IntelligenceReadTools {
  return {
    async call(name: string): Promise<unknown> {
      if (name === 'get_plugin_settings') {
        const settings = source.getSettings();
        return {
          language: settings.language === 'en' ? 'en' : 'zh',
          cognitiveAgent: settings.cognitiveAgent || '',
          cognitiveModel: settings.cognitiveModel || 'auto'
        };
      }
      if (name === 'get_today_review') {
        const review = await source.getTodayReview?.();
        return review ? {
          summary: String(review.summary || '').slice(0, 500),
          items: (review.items || []).map(item => String(item).slice(0, 200)).slice(0, 10)
        } : null;
      }
      if (name !== 'list_projects' && name !== 'get_current_project') {
        throw new Error(`Unknown read tool: ${name}`);
      }
      const projects = await source.getProjects();
      if (name === 'list_projects') {
        return projects.map(project => ({
          name: project.name,
          ...(project.priority ? { priority: project.priority } : {}),
          ...(project.description ? { description: project.description.slice(0, 500) } : {})
        }));
      }
      const project = projects.find(item => item.path === source.getSelectedProjectPath());
      if (!project) return { selectedProject: null };
      const steps = await source.getCurrentSteps();
      return {
        selectedProject: {
          name: project.name,
          ...(project.priority ? { priority: project.priority } : {}),
          ...(project.description ? { description: project.description.slice(0, 500) } : {})
        },
        currentSteps: steps === null ? null : steps.map(step => ({ title: step.title, status: step.status }))
      };
    }
  };
}
