export {};

declare global {
  const useCallback: typeof import('preact/hooks').useCallback;
  const useContext: typeof import('preact/hooks').useContext;
  const useDebugValue: typeof import('preact/hooks').useDebugValue;
  const useEffect: typeof import('preact/hooks').useEffect;
  const useErrorBoundary: typeof import('preact/hooks').useErrorBoundary;
  const useId: typeof import('preact/hooks').useId;
  const useImperativeHandle: typeof import('preact/hooks').useImperativeHandle;
  const useLayoutEffect: typeof import('preact/hooks').useLayoutEffect;
  const useMemo: typeof import('preact/hooks').useMemo;
  const useReducer: typeof import('preact/hooks').useReducer;
  const useRef: typeof import('preact/hooks').useRef;
  const useState: typeof import('preact/hooks').useState;
  const useComputed: typeof import('@preact/signals').useComputed;
  const useModel: typeof import('@preact/signals').useModel;
  const useSignal: typeof import('@preact/signals').useSignal;
  const useSignalEffect: typeof import('@preact/signals').useSignalEffect;

  const UiDialog: typeof import('../../templates/starter-web/ui/dialog.js').UiDialog;
  const UiField: typeof import('../../templates/starter-web/ui/field.js').UiField;
  const UiLayout: typeof import('../../templates/starter-web/ui/layout.js').UiLayout;
  const UiCounter: typeof import('../../templates/starter-web/ui/counter.js').UiCounter;
  const UiRegisterForm: typeof import('../../templates/starter-web/ui/register-form.js').UiRegisterForm;
  const UiResetForm: typeof import('../../templates/starter-web/ui/reset-password.js').UiResetForm;
}
