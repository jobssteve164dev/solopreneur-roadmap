export type IntelligenceReadToolName = 'list_projects' | 'get_current_project' | 'get_plugin_settings' | 'get_today_review';

export interface IntelligenceReadToolSource {
  getProjects(): Array<{ name: string; path: string; priority?: string; description?: string }>;
  getSelectedProjectPath(): string;
  getCurrentSteps(): Array<{ title: string; status: string }> | null;
  getSettings(): { language: string; cognitiveAgent?: string; cognitiveModel?: string };
  getTodayReview?(): { summary: string; items: string[] } | null;
}

export interface IntelligenceReadTools {
  call(name: string): Promise<unknown>;
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
        const review = source.getTodayReview?.();
        return review ? {
          summary: String(review.summary || '').slice(0, 500),
          items: (review.items || []).map(item => String(item).slice(0, 200)).slice(0, 10)
        } : null;
      }
      if (name !== 'list_projects' && name !== 'get_current_project') {
        throw new Error(`Unknown read tool: ${name}`);
      }
      const projects = source.getProjects();
      if (name === 'list_projects') {
        return projects.map(project => ({
          name: project.name,
          ...(project.priority ? { priority: project.priority } : {}),
          ...(project.description ? { description: project.description.slice(0, 500) } : {})
        }));
      }
      const project = projects.find(item => item.path === source.getSelectedProjectPath());
      if (!project) return { selectedProject: null };
      const steps = source.getCurrentSteps();
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
