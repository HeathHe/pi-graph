// ---------------------------------------------------------------------------
// PromptRegistry — central registry for prompt builders
// ---------------------------------------------------------------------------
import { DirectPromptBuilder } from './builders/direct-builder.js';
import { SkillPromptBuilder } from './builders/skill-builder.js';
import { TemplatePromptBuilder } from './builders/template-builder.js';
import { DecomposePromptBuilder } from './builders/decompose-builder.js';
import { AssessmentPromptBuilder } from './builders/assessment-builder.js';
export class PromptRegistry {
    builders = new Map();
    register(builder) {
        this.builders.set(builder.name, builder);
    }
    get(name) {
        return this.builders.get(name);
    }
    list() {
        return Array.from(this.builders.keys());
    }
    static createDefault() {
        const registry = new PromptRegistry();
        registry.register(new DirectPromptBuilder());
        registry.register(new SkillPromptBuilder());
        registry.register(new TemplatePromptBuilder());
        registry.register(new DecomposePromptBuilder());
        registry.register(new AssessmentPromptBuilder());
        return registry;
    }
}
//# sourceMappingURL=prompt-registry.js.map