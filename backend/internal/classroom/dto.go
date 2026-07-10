package classroom

// CreateSessionRequest is the validated body for creating a session.
type CreateSessionRequest struct {
	ClassroomName string `json:"classroomName" validate:"required,min=1,max=200"`
	SpeakerName   string `json:"speakerName" validate:"required,min=1,max=200"`
	// ContextNote is an optional lesson topic / story synopsis the teacher
	// provides up front. It is fed to the translator as background context so
	// proper nouns and domain terms (e.g. a fable's characters) translate
	// accurately and consistently.
	ContextNote string `json:"contextNote" validate:"max=4000"`
}

// UpdateSummaryRequest is the teacher-reviewed summary draft saved before
// students receive the recap.
type UpdateSummaryRequest struct {
	SummaryTh   string   `json:"summaryTh" validate:"max=12000"`
	SummaryEn   string   `json:"summaryEn" validate:"max=12000"`
	KeyPointsTh []string `json:"keyPointsTh"`
	KeyPointsEn []string `json:"keyPointsEn"`
}

// CreateSessionResponse is returned after a session is created.
type CreateSessionResponse struct {
	SessionID      string `json:"sessionId"`
	SourceLanguage string `json:"sourceLanguage"`
	TargetLanguage string `json:"targetLanguage"`
	Status         string `json:"status"`
}

// RealtimeTranslationClientSecretResponse exposes only a short-lived browser credential.
type RealtimeTranslationClientSecretResponse struct {
	ClientSecret         string `json:"clientSecret"`
	ExpiresAt            int64  `json:"expiresAt"`
	TranslationSessionId string `json:"translationSessionId"`
	LastCommitNo         int    `json:"lastCommitNo"`
	Model                string `json:"model"`
	TargetLanguage       string `json:"targetLanguage"`
}

// NewCreateSessionResponse maps a Session to its creation response shape.
func NewCreateSessionResponse(s *Session) CreateSessionResponse {
	return CreateSessionResponse{
		SessionID:      s.SessionID,
		SourceLanguage: s.SourceLanguage,
		TargetLanguage: s.TargetLanguage,
		Status:         s.Status,
	}
}
