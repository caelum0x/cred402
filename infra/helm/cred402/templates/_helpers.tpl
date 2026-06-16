{{- define "cred402.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "cred402.fullname" -}}
{{- printf "%s-%s" .Release.Name (include "cred402.name" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "cred402.labels" -}}
app.kubernetes.io/name: {{ include "cred402.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}

{{- define "cred402.selectorLabels" -}}
app.kubernetes.io/name: {{ include "cred402.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}
