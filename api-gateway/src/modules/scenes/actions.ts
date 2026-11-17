/**
 * Which catalog operations a scene step may use. A scene fixes its steps when
 * it is saved, so an operation qualifies only when everything it needs is
 * known then:
 * - it is not a protected-resource session (camera live view or playback
 *   needs someone watching);
 * - it is not a pure query (no effect, answered by an ACK, e.g. list_recordings);
 * - no input names a runtime object (`…_id`, e.g. an incident) or an absolute
 *   time (`format: date-time`).
 * The app lists only what GET /scenes/actions returns, so this is the one rule.
 */
type CatalogOperation = Record<string, any>;

export type SceneActionProblem = 'RESOURCE_SESSION' | 'QUERY' | 'RUNTIME_INPUT';

export function sceneActionProblem(operation: CatalogOperation): SceneActionProblem | null {
    const effects: any[] = Array.isArray(operation.effects) ? operation.effects : [];
    if (effects.some(effect => effect?.type === 'create_resource_session')) return 'RESOURCE_SESSION';
    if (effects.length === 0 && operation.ack_policy?.completion_signal === 'ack') return 'QUERY';
    const input: Record<string, any> = operation.input || {};
    for (const [name, schema] of Object.entries(input)) {
        if (name.endsWith('_id') || schema?.format === 'date-time') return 'RUNTIME_INPUT';
    }
    return null;
}

/**
 * Operations the app asks the user to confirm (or to re-enter the password
 * for). Inside a scene they are "protected": running a scene that contains
 * one needs the account password each time.
 */
export function isProtectedOperation(operation: CatalogOperation): boolean {
    return Boolean(operation.confirmation) && operation.confirmation !== 'none';
}

export function operationLabel(operation: CatalogOperation, operationName: string): string {
    return String(operation.presentation?.label || operationName);
}

/** Display name of a capability instance ("Khóa cửa chính"). */
export function instanceLabel(product: any, instanceId: string): string {
    const instance = (product?.capability_instances || [])
        .find((item: any) => item.instance_id === instanceId);
    return String(instance?.presentation?.display_name || instanceId);
}

/** May this member (owner or granted permission) run [operation]? */
export function mayRun(device: { role: string; granted_permissions: string[] }, operation: CatalogOperation) {
    return device.role === 'owner' || device.granted_permissions.includes(operation.permission);
}
